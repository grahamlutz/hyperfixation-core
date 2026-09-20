import { quoteIdent } from "@hyperfixation/db";
import {
  createLocalDirectoryBackupSource,
  createS3BackupSource,
  type BackupDump,
  type BackupSource,
} from "./backup-source.js";
import {
  loadOperatorConfig,
  pgAdminUser,
  postgresContainers,
  requireOperatorConfig,
} from "./config.js";
import {
  openDatabase,
  openDatabaseUrl,
  redactPasswords,
  DEFAULT_POSTGRES_PORT,
  type AdminCredentials,
  type Database,
} from "./database.js";
import { deriveNames } from "./names.js";
import { REQUIRED_EXTENSIONS } from "./provision-database.js";
import { createSshRunner, type Runner } from "./runner.js";
import { openAppState, type AppStateStore } from "./state.js";

/** Appended to `hf_<app>` for the database the dump is restored into and then dropped. */
export const SCRATCH_SUFFIX = "_restore_check";

/** Postgres truncates an identifier past this, which would collide with the live database. */
const MAX_IDENTIFIER_BYTES = 63;

/** Older than this and the dump gets a warning line; it never changes the exit code. */
export const STALE_DUMP_HOURS = 36;

const CLUSTER_ADMIN_DATABASE = "postgres";

export type RestoreVerdict = "ok" | "mismatch" | "live only" | "restored only";

export interface RestoreCheckRow {
  table: string;
  /** Absent when the table is not in the live database. */
  live?: number;
  /** Absent when the table is not in the restored dump. */
  restored?: number;
  verdict: RestoreVerdict;
}

export interface RestoreCheckResult {
  databaseName: string;
  /** Created and dropped by this call; never left behind. */
  scratchDatabase: string;
  dump: BackupDump;
  dumpAgeHours: number;
  /** The dump is older than `STALE_DUMP_HOURS`. Informational. */
  dumpStale: boolean;
  /** One row per table, `hf_*` or carrying `normalized_name`, sorted by name. */
  rows: readonly RestoreCheckRow[];
  /** Every row's verdict is `ok`. The command's exit code is `ok ? 0 : 1`. */
  ok: boolean;
}

export class RestoreCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreCheckError";
  }
}

export interface RestoreCheckOptions {
  /** The name `hf new` was given; `hf_<app>` and the migrator role derive from it. */
  app: string;
  state: AppStateStore;
  source: BackupSource;
  /** Where `pg_restore` runs: the box, or this machine in a test. */
  runner: Runner;
  /** How the scratch database is created and both sides are counted. */
  database: Database | string;
  /**
   * The cluster's admin URL **as the runner sees it**, for `pg_restore`.
   *
   * Not the same address as `database`: the laptop reaches the cluster through an `ssh -L`
   * forward onto a local port, and a `pg_restore` running on the far side of that forward has to
   * dial the box's own loopback. Defaults to `database`'s URL, which is what a test wants when
   * both sides are the same machine.
   */
  restoreAdminUrl?: string;
  /** The `pg_restore` binary on the runner. */
  pgRestorePath?: string;
  now?: Date;
}

/**
 * Restores the newest dump of `hf_<app>` beside the live database and compares row counts.
 *
 * The scratch database is dropped in a `finally`: it holds a full copy of the app's data, so
 * leaving one behind on a failure would double the disk the app uses until someone noticed.
 *
 * `lastRestoreCheckAt` is written only by a run that counted both sides and found them equal.
 * `hf doctor` warns on a stale timestamp, so a check that died halfway — or one that found a
 * mismatch — has to leave the warning standing until a check actually passes.
 */
export async function restoreCheck(options: RestoreCheckOptions): Promise<RestoreCheckResult> {
  // Refuses a name carrying a quote, a semicolon or a glob before it reaches SQL, `find` or
  // `pg_restore`'s argv.
  const names = deriveNames(options.app);
  const scratchDatabase = `${names.databaseName}${SCRATCH_SUFFIX}`;
  if (Buffer.byteLength(scratchDatabase) > MAX_IDENTIFIER_BYTES) {
    throw new RestoreCheckError(
      `${scratchDatabase} is longer than Postgres's ${String(MAX_IDENTIFIER_BYTES)}-byte ` +
        `identifier limit, and a truncated name would collide with another database`,
    );
  }

  const dump = await options.source.newest(names.databaseName);
  if (dump === undefined) {
    throw new RestoreCheckError(
      `no ${names.databaseName} dump in the ${options.source.kind} backup source: nothing to check`,
    );
  }

  const db =
    typeof options.database === "string" ? openDatabaseUrl(options.database) : options.database;
  const clusterUrl = db.adminUrl();
  if (clusterUrl === undefined) {
    throw new RestoreCheckError(
      `a restore cannot be run over the ${db.kind} transport: pg_restore needs an address. ` +
        "Name the Postgres container — HF_DB_CONTAINER, or HF_COOLIFY_POSTGRES_UUID — so the " +
        "tunnel can discover one.",
    );
  }
  const restoreTarget = urlOnto(options.restoreAdminUrl ?? clusterUrl, scratchDatabase);

  const now = options.now ?? new Date();
  const dumpAgeHours = (now.getTime() - dump.takenAt.getTime()) / 3_600_000;

  try {
    // A scratch database left by a killed run is the one thing in the way of this one.
    await db.query(`DROP DATABASE IF EXISTS ${quoteIdent(scratchDatabase)} WITH (FORCE)`);
    await db.query(`CREATE DATABASE ${quoteIdent(scratchDatabase)}`);

    try {
      // Its own connection, so that it can be closed before the drop: `WITH (FORCE)` terminates
      // the backends it finds, and a `pg` client whose backend was killed under it raises an
      // error event nothing is listening for.
      const scratch = openDatabaseUrl(urlOnto(clusterUrl, scratchDatabase));
      let rows: readonly RestoreCheckRow[];
      try {
        for (const extension of REQUIRED_EXTENSIONS) {
          await scratch.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(extension)}`);
        }
        // What `provisionRoles` grants the migrator in the live database. Without them the
        // restore runs as a role that may not create anything: the extensions have to be created
        // by the admin (pgvector needs a superuser) but everything the dump carries is the
        // migrator's, which is the ownership the live database has.
        await db.query(
          `GRANT CONNECT, CREATE ON DATABASE ${quoteIdent(scratchDatabase)} ` +
            `TO ${quoteIdent(names.migratorRole)}`,
        );
        await scratch.query(
          `GRANT CREATE, USAGE ON SCHEMA public TO ${quoteIdent(names.migratorRole)}`,
        );
        await runRestore(options, restoreTarget, names.migratorRole, dump.path);
        rows = compare(await countTables(db, names.databaseName), await countTables(scratch));
      } finally {
        await scratch.close();
      }

      const ok = rows.every((row) => row.verdict === "ok");
      if (ok) await options.state.patch({ lastRestoreCheckAt: now.toISOString() });

      return {
        databaseName: names.databaseName,
        scratchDatabase,
        dump,
        dumpAgeHours,
        dumpStale: dumpAgeHours > STALE_DUMP_HOURS,
        rows,
        ok,
      };
    } finally {
      await db.query(`DROP DATABASE IF EXISTS ${quoteIdent(scratchDatabase)} WITH (FORCE)`);
    }
  } finally {
    if (typeof options.database === "string") await db.close();
  }
}

/** The argv `restoreCheck` runs — the array the test asserts against. */
export function pgRestoreArgv(options: {
  url: string;
  role: string;
  file: string;
  pgRestorePath?: string;
}): string[] {
  return [
    options.pgRestorePath ?? "pg_restore",
    "--no-owner",
    // Every object comes out owned by the migrator, as in the live database. `--no-comments`
    // because a dump's `COMMENT ON EXTENSION` belongs to the admin that created the extension,
    // and a comment nobody may set is not a restore failure.
    "--no-comments",
    `--role=${options.role}`,
    "--dbname",
    options.url,
    options.file,
  ];
}

async function runRestore(
  options: RestoreCheckOptions,
  url: string,
  role: string,
  file: string,
): Promise<void> {
  const argv = pgRestoreArgv({ url, role, file, pgRestorePath: options.pgRestorePath });
  const result = await options.runner.exec(argv);
  if (result.code !== 0) {
    // `url` carries the cluster's admin password, and so does anything pg_restore echoed of it.
    throw new RestoreCheckError(
      `pg_restore exited ${String(result.code)} restoring ${file}: ` +
        redactPasswords(result.stderr.trim()),
    );
  }
}

/**
 * Row counts for every table the app's data lives in: `hf_*`, plus every table carrying
 * `normalized_name`, which is how `@hyperfixation/db` spells a record table the app declared.
 */
async function countTables(db: Database, database?: string): Promise<Map<string, number>> {
  const { rows: tables } = await db.query(
    `SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND (c.relname LIKE 'hf\\_%'
             OR EXISTS (SELECT 1
                          FROM pg_attribute a
                         WHERE a.attrelid = c.oid
                           AND a.attname = 'normalized_name'
                           AND a.attnum > 0
                           AND NOT a.attisdropped))
      ORDER BY c.relname`,
    { database },
  );

  const names = tables.map((row) => row[0]).filter((name): name is string => name !== undefined);
  const counts = new Map<string, number>();
  if (names.length === 0) return counts;

  const { rows } = await db.query(
    names
      .map(
        (name) =>
          `SELECT ${quoteLiteral(name)} AS relname, count(*) AS rows FROM public.${quoteIdent(name)}`,
      )
      .join(" UNION ALL "),
    { database },
  );
  for (const [name, count] of rows) {
    if (name !== undefined && count !== undefined) counts.set(name, Number(count));
  }
  return counts;
}

/**
 * One row per table either side has.
 *
 * A table on one side only is its own verdict rather than a crash or a zero: an app migration
 * between the backup and the check is the ordinary reason for it, and reading it as a count of
 * zero would make an added table look like lost data.
 */
function compare(
  live: Map<string, number>,
  restored: Map<string, number>,
): readonly RestoreCheckRow[] {
  const tables = [...new Set([...live.keys(), ...restored.keys()])].sort();
  return tables.map((table) => {
    const liveCount = live.get(table);
    const restoredCount = restored.get(table);
    const verdict: RestoreVerdict =
      liveCount === undefined
        ? "restored only"
        : restoredCount === undefined
          ? "live only"
          : liveCount === restoredCount
            ? "ok"
            : "mismatch";
    return {
      table,
      ...(liveCount === undefined ? {} : { live: liveCount }),
      ...(restoredCount === undefined ? {} : { restored: restoredCount }),
      verdict,
    };
  });
}

/** The table `hf restore-check` prints, and the two lines around it. */
export function formatRestoreCheck(result: RestoreCheckResult): string[] {
  const age = `${result.dumpAgeHours.toFixed(1)} h old`;
  const lines = [`${result.databaseName}: ${result.dump.path}, ${age}`];
  if (result.dumpStale) {
    lines.push(`WARNING: the dump is ${age} — over ${String(STALE_DUMP_HOURS)} h`);
  }

  const header = ["table", "live", "restored", "verdict"] as const;
  const cells = result.rows.map((row) => [
    row.table,
    row.live === undefined ? "—" : String(row.live),
    row.restored === undefined ? "—" : String(row.restored),
    row.verdict,
  ]);
  const widths = header.map((name, column) =>
    Math.max(name.length, ...cells.map((row) => row[column]?.length ?? 0)),
  );
  const line = (row: readonly string[]): string =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd();

  lines.push(line(header), ...cells.map(line));

  const mismatched = result.rows.filter((row) => row.verdict !== "ok").length;
  lines.push(
    result.ok
      ? `${String(result.rows.length)} table(s) matched`
      : `${String(mismatched)} of ${String(result.rows.length)} table(s) did not match`,
  );
  return lines;
}

export interface RestoreCheckAppOptions {
  app: string;
  /** Where the dumps are; defaults to Coolify's backup directory on the box. */
  backupDir?: string;
  /** Read the dump from Hetzner object storage instead. Not implemented; see `backup-source`. */
  fromS3?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * `hf restore-check <name>`: the operator config, an `ssh` runner onto the box, and the check.
 *
 * The cluster admin password comes from libpq's own `PGPASSWORD` until E3 records Coolify's — the
 * operator config has no key for it, and inventing one before the box has been looked at is
 * exactly what risk 3 warns against.
 */
export async function restoreCheckApp(
  options: RestoreCheckAppOptions,
): Promise<RestoreCheckResult> {
  const env = options.env ?? process.env;
  const config = await loadOperatorConfig({ env });
  const { HF_SSH_HOST } = requireOperatorConfig(config, ["HF_SSH_HOST"], { env });

  const runner = createSshRunner({ host: HF_SSH_HOST });
  const admin: AdminCredentials = { user: pgAdminUser(config), password: env.PGPASSWORD };
  const db = await openDatabase(runner, { admin, containers: postgresContainers(config) });

  try {
    return await restoreCheck({
      app: options.app,
      state: await openAppState(options.app, { env }),
      source:
        options.fromS3 === true
          ? createS3BackupSource()
          : createLocalDirectoryBackupSource({ runner, directory: options.backupDir }),
      runner,
      database: db,
      restoreAdminUrl: boxAdminUrl(admin, db.boxAddress),
    });
  } finally {
    await db.close();
  }
}

/**
 * The cluster as the box itself sees it, where `pg_restore` runs.
 *
 * `address` is whatever the tunnel settled on: with 5432 unpublished the box's loopback is no more
 * a listener for `pg_restore` than for the forward, and the container's address on the docker
 * network is what both have to dial.
 */
function boxAdminUrl(
  admin: AdminCredentials,
  address: { host: string; port: number } | undefined,
): string {
  const url = new URL(`postgresql://${address?.host ?? "127.0.0.1"}`);
  url.port = String(address?.port ?? DEFAULT_POSTGRES_PORT);
  url.username = encodeURIComponent(admin.user);
  if (admin.password !== undefined) url.password = encodeURIComponent(admin.password);
  url.pathname = `/${CLUSTER_ADMIN_DATABASE}`;
  return url.toString();
}

function urlOnto(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
