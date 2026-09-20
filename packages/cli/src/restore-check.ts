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
  DEFAULT_PG_ADMIN_USER,
} from "./config.js";
import {
  findPostgresContainer,
  openDatabase,
  openDatabaseUrl,
  redactPasswords,
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

/** Older than this and the dump gets a WARN line, which — as in `hf doctor` — exits 1. */
export const STALE_DUMP_HOURS = 24;

/**
 * Tables a live row is only ever added to, so a live count above the dump's is the app working,
 * not lost data.
 *
 * X1 found this the hard way: against a 1.3-hour-old dump of a running app, 9 of 24 tables
 * "mismatched" purely from churn since the dump, and the same check against a fresh dump matched
 * all 24. A table earns a place here only when no code path deletes from it and none updates it
 * in a way that lowers its count — checked against `packages/db/src/schema` and every statement
 * in `core`, `workflows`, `auth` and `admin`. Anything else, including a table whose rows merely
 * look permanent, stays exact: a false `ok` here hides exactly the data loss this command exists
 * to catch.
 */
export const APPEND_ONLY_TABLES: readonly string[] = [
  // Insert-only ledgers: nothing but `INSERT` touches either.
  "hf_audit",
  "hf_activity",
  // Ledger rows are inserted `started` and then `UPDATE`d to a terminal status — including
  // `reconcile()`'s sweep to `abandoned`/`uncertain`, which is still an update.
  "hf_llm_call",
  "hf_action_log",
  // Inserted pending and decided by `UPDATE`; `reconcile()` step (5) expires a stale one the
  // same way. The delete guard exists precisely so an approval outlives the record it names.
  "hf_approval",
  // Inserted, or upserted on `(run_id, key, spec_name)` by a replayed step; never deleted.
  "hf_score",
  // `INSERT` at the start of a source run, `UPDATE` at its end.
  "hf_source_run",
  // `INSERT` at `runs.start`; every later write is an `UPDATE` of status, attempt or the
  // fencing token. Runs are never purged — there is no retention sweep.
  "hf_run",
];

const APPEND_ONLY = new Set(APPEND_ONLY_TABLES);

export type RestoreVerdict = "ok" | "mismatch" | "live only" | "restored only";

export interface RestoreCheckRow {
  table: string;
  /** Absent when the table is not in the live database. */
  live?: number;
  /** Absent when the table is not in the restored dump. */
  restored?: number;
  /**
   * Rows the live side gained since the dump, on an `APPEND_ONLY_TABLES` table.
   *
   * Drift is not its own verdict because it is not its own outcome: the restore held everything
   * the dump had, which is `ok`. The column prints it as `ok (drift +N)` so the operator can see
   * why two counts differ without having to decide whether it mattered.
   */
  drift?: number;
  verdict: RestoreVerdict;
}

export interface RestoreCheckResult {
  databaseName: string;
  /** Created and dropped by this call; never left behind. */
  scratchDatabase: string;
  dump: BackupDump;
  dumpAgeHours: number;
  /** The dump is older than `STALE_DUMP_HOURS`; on its own enough to exit 1. */
  dumpStale: boolean;
  /** Exact matching was asked for, so no table was allowed to drift. */
  strict: boolean;
  /** One row per table, `hf_*` or carrying `normalized_name`, sorted by name. */
  rows: readonly RestoreCheckRow[];
  /** Every row's verdict is `ok`, drift included. What `lastRestoreCheckAt` is written on. */
  matched: boolean;
  /** `matched` and the dump is not stale. The command's exit code is `ok ? 0 : 1`. */
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
  /** Where the dump file is and where `docker` is run: the box, or this machine in a test. */
  runner: Runner;
  /** How the scratch database is created and both sides are counted. */
  database: Database | string;
  /**
   * The Postgres container `pg_restore` runs inside.
   *
   * The box host has no Postgres client tools — Postgres runs only in Coolify's container — so a
   * `pg_restore` on the host exits 127. The dump is the host's and is not mounted into the
   * container, so it goes down `docker exec -i`'s stdin.
   */
  container: string;
  /** The superuser inside the container; `HF_PG_ADMIN_USER`, default `postgres`. */
  adminUser?: string;
  /**
   * @deprecated Unused: `pg_restore` no longer dials an address, it runs beside the server inside
   * `container`. Removed in 0.2.0.
   */
  restoreAdminUrl?: string;
  /** The `pg_restore` binary inside the container. */
  pgRestorePath?: string;
  /** Compare every table exactly, `APPEND_ONLY_TABLES` included. */
  strict?: boolean;
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
      `a restore cannot be checked over the ${db.kind} transport: counting the restored side ` +
        "needs an address a client library can dial. Name the Postgres container — " +
        "HF_DB_CONTAINER, or HF_COOLIFY_POSTGRES_UUID — so the tunnel can discover one.",
    );
  }

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
        await runRestore(options, scratchDatabase, names.migratorRole, dump.path);
        rows = compare(
          await countTables(db, names.databaseName),
          await countTables(scratch),
          options.strict ?? false,
        );
      } finally {
        await scratch.close();
      }

      const dumpStale = dumpAgeHours > STALE_DUMP_HOURS;
      const matched = rows.every((row) => row.verdict === "ok");
      // A stale dump keeps the exit code but not the timestamp: the restore itself was proved,
      // and it is `hf doctor` that decides how long a proof stays good.
      if (matched) await options.state.patch({ lastRestoreCheckAt: now.toISOString() });

      return {
        databaseName: names.databaseName,
        scratchDatabase,
        dump,
        dumpAgeHours,
        dumpStale,
        strict: options.strict ?? false,
        rows,
        matched,
        ok: matched && !dumpStale,
      };
    } finally {
      await db.query(`DROP DATABASE IF EXISTS ${quoteIdent(scratchDatabase)} WITH (FORCE)`);
    }
  } finally {
    if (typeof options.database === "string") await db.close();
  }
}

/**
 * The argv `restoreCheck` runs — the array the test asserts against.
 *
 * @deprecated The box host has no `pg_restore`; the restore runs inside the Postgres container.
 * Use `pgRestoreInContainerArgv`. Removed in 0.2.0.
 */
export function pgRestoreArgv(options: {
  url: string;
  role: string;
  file: string;
  pgRestorePath?: string;
}): string[] {
  return [
    options.pgRestorePath ?? "pg_restore",
    "--no-owner",
    "--no-comments",
    `--role=${options.role}`,
    "--dbname",
    options.url,
    options.file,
  ];
}

/**
 * The argv `restoreCheck` runs — the array the test asserts against.
 *
 * No `--dbname` URL: inside the container the server is on the local socket, so the admin user
 * and the database name are all it takes and no password crosses an argv. The dump arrives on
 * stdin, which is why there is no file argument either.
 */
export function pgRestoreInContainerArgv(options: {
  container: string;
  adminUser: string;
  database: string;
  role: string;
  pgRestorePath?: string;
}): string[] {
  return [
    "docker",
    "exec",
    "-i",
    options.container,
    options.pgRestorePath ?? "pg_restore",
    "--no-owner",
    // Every object comes out owned by the migrator, as in the live database. `--no-comments`
    // because a dump's `COMMENT ON EXTENSION` belongs to the admin that created the extension,
    // and a comment nobody may set is not a restore failure.
    "--no-comments",
    `--role=${options.role}`,
    "-U",
    options.adminUser,
    "-d",
    options.database,
  ];
}

async function runRestore(
  options: RestoreCheckOptions,
  database: string,
  role: string,
  file: string,
): Promise<void> {
  const { container } = options;
  const argv = pgRestoreInContainerArgv({
    container,
    adminUser: options.adminUser ?? DEFAULT_PG_ADMIN_USER,
    database,
    role,
    pgRestorePath: options.pgRestorePath,
  });
  const result = await options.runner.exec(argv, { inputFile: file });
  if (result.code === 0) return;

  // Anything `pg_restore` echoed of a connection string carries the cluster's admin password.
  const stderr = redactPasswords(result.stderr.trim());
  throw new RestoreCheckError(
    `pg_restore exited ${String(result.code)} restoring ${file} in ${container}: ${stderr}` +
      (result.code === NOT_FOUND_EXIT
        ? ` — exit ${String(NOT_FOUND_EXIT)} means "command not found". The box host has no ` +
          "Postgres client tools; only the container does. Check that docker is on the box's " +
          `PATH and that ${container} is the Postgres container (HF_DB_CONTAINER, or ` +
          "HF_COOLIFY_POSTGRES_UUID)."
        : ""),
  );
}

/** A shell's, and `docker exec`'s, "command not found". */
const NOT_FOUND_EXIT = 127;

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
 *
 * An `APPEND_ONLY_TABLES` table the live side is *ahead* on is `ok` with a `drift`, unless
 * `strict`. A restored count above the live one is still a `mismatch` there: the dump cannot
 * hold rows an append-only live table has since lost unless something did lose them.
 */
function compare(
  live: Map<string, number>,
  restored: Map<string, number>,
  strict: boolean,
): readonly RestoreCheckRow[] {
  const tables = [...new Set([...live.keys(), ...restored.keys()])].sort();
  return tables.map((table) => {
    const liveCount = live.get(table);
    const restoredCount = restored.get(table);
    const drifted =
      !strict &&
      APPEND_ONLY.has(table) &&
      liveCount !== undefined &&
      restoredCount !== undefined &&
      restoredCount < liveCount;
    const verdict: RestoreVerdict =
      liveCount === undefined
        ? "restored only"
        : restoredCount === undefined
          ? "live only"
          : liveCount === restoredCount || drifted
            ? "ok"
            : "mismatch";
    return {
      table,
      ...(liveCount === undefined ? {} : { live: liveCount }),
      ...(restoredCount === undefined ? {} : { restored: restoredCount }),
      ...(drifted && liveCount !== undefined && restoredCount !== undefined
        ? { drift: liveCount - restoredCount }
        : {}),
      verdict,
    };
  });
}

/** The table `hf restore-check` prints, and the two lines around it. */
export function formatRestoreCheck(result: RestoreCheckResult): string[] {
  const age = `${result.dumpAgeHours.toFixed(1)} h old`;
  const lines = [
    `${result.databaseName}: ${result.dump.path}, ${age}${result.strict ? ", strict" : ""}`,
  ];
  if (result.dumpStale) {
    lines.push(
      `WARN: the dump is ${age} — over ${String(STALE_DUMP_HOURS)} h; ` +
        "this compares against stale data",
    );
  }

  const header = ["table", "live", "restored", "verdict"] as const;
  const cells = result.rows.map((row) => [
    row.table,
    row.live === undefined ? "—" : String(row.live),
    row.restored === undefined ? "—" : String(row.restored),
    row.drift === undefined ? row.verdict : `${row.verdict} (drift +${String(row.drift)})`,
  ]);
  const widths = header.map((name, column) =>
    Math.max(name.length, ...cells.map((row) => row[column]?.length ?? 0)),
  );
  const line = (row: readonly string[]): string =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd();

  lines.push(line(header), ...cells.map(line));

  const drifted = result.rows.filter((row) => row.drift !== undefined).length;
  const failed = result.rows.filter((row) => row.verdict !== "ok").length;
  const drift = drifted === 0 ? "" : `, ${String(drifted)} with drift since the dump`;
  lines.push(
    result.matched
      ? `${String(result.rows.length)} table(s) matched${drift}`
      : `${String(failed)} of ${String(result.rows.length)} table(s) did not match${drift}`,
  );
  return lines;
}

export interface RestoreCheckAppOptions {
  app: string;
  /** Where the dumps are; defaults to Coolify's backup directory on the box. */
  backupDir?: string;
  /** Read the dump from Hetzner object storage instead. Not implemented; see `backup-source`. */
  fromS3?: boolean;
  /** Compare every table exactly, `APPEND_ONLY_TABLES` included. */
  strict?: boolean;
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
  const containers = postgresContainers(config);
  const db = await openDatabase(runner, { admin, containers });

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
      container: await restoreContainer(runner, db, containers),
      adminUser: admin.user,
      strict: options.strict,
    });
  } finally {
    await db.close();
  }
}

/**
 * The container `pg_restore` runs inside.
 *
 * `openDatabase` already knows it whenever the box's loopback had no listener, which is the box
 * Coolify builds; a box that does publish 5432 answers on the loopback and never looks, so the
 * discovery runs here instead of leaving the check with nowhere to restore.
 */
async function restoreContainer(
  runner: Runner,
  db: Database,
  containers: readonly string[],
): Promise<string> {
  if (db.container !== undefined) return db.container;
  if (containers.length === 0) {
    throw new RestoreCheckError(
      "pg_restore has to run inside the Postgres container — the box host has no Postgres " +
        "client tools — and no container was named. Set HF_DB_CONTAINER, or " +
        "HF_COOLIFY_POSTGRES_UUID, in the operator config.",
    );
  }
  return (await findPostgresContainer(runner, containers)).container;
}

function urlOnto(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
