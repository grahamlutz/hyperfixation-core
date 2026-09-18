import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  BootCheckFailure,
  runBootChecks,
  type RecordTable,
} from "@hyperfixation/db";
import { CORE_MIGRATIONS_DIR, CORE_MIGRATIONS_TABLE } from "@hyperfixation/db/migrator";
import { Client } from "pg";
import { resolveApp, type ResolvedApp } from "./app.js";
import { probeApp } from "./probe.js";
import { requireEnv } from "./require-env.js";

/** Where drizzle records the app's own migrations; core's are in `CORE_MIGRATIONS_TABLE`. */
const APP_MIGRATIONS_TABLE = "__drizzle_migrations";

export interface CheckFinding {
  /** `env`, `migrations`, `registry`, or a boot-check code. */
  code: string;
  message: string;
}

export interface CheckAppResult {
  app: ResolvedApp;
  findings: readonly CheckFinding[];
  /** Undefined when the registry could not be read; E001–E003 then checked nothing. */
  recordTables: readonly RecordTable[] | undefined;
  ok: boolean;
}

/**
 * `hf check` — the three things that are wrong about a deploy before any request reaches it:
 * an env var the app declares and the environment does not carry, a migration in the tree that
 * is not in the database, and E001–E006 against the role the app actually connects as.
 *
 * It reports every finding rather than throwing on the first. A missing var and a pending
 * migration are usually the same mistake — an incomplete deploy — and fixing them one error
 * message at a time is three round trips through a build.
 */
export async function checkApp(options: { dir?: string } = {}): Promise<CheckAppResult> {
  const app = await resolveApp(options.dir);
  const findings: CheckFinding[] = [];

  findings.push(...missingEnv(app));

  const databaseUrl = app.env.DATABASE_URL;
  const migratorUrl = app.env.MIGRATOR_DATABASE_URL;

  const registry = await probeApp(app);
  if (registry === undefined) {
    findings.push({
      code: "registry",
      message:
        `could not read ${app.appName}'s registry from src/hyperfixation.ts; ` +
        "E001-E003 checked no record tables",
    });
  }

  if (migratorUrl !== undefined && migratorUrl !== "") {
    findings.push(...(await pendingMigrations(app, migratorUrl)));
  }

  if (databaseUrl !== undefined && databaseUrl !== "") {
    try {
      await runBootChecks({
        databaseUrl,
        recordTables: registry?.recordTables ?? [],
        appMigrationsDir: app.migrationsDir,
      });
    } catch (error) {
      findings.push(
        error instanceof BootCheckFailure
          ? { code: error.code, message: error.message }
          : { code: "boot", message: (error as Error).message },
      );
    }
  }

  return { app, findings, recordTables: registry?.recordTables, ok: findings.length === 0 };
}

/**
 * The app's env contract is `.env.example`, not a list this package keeps: track B's
 * `compose-envs.test.ts` already pins that file, both compose blocks and `REQUIRED_ENV` to each
 * other, so reading it here means an app that adds a var of its own is checked for it too.
 *
 * Absent, not empty. `.env.example` ships `SENTRY_DSN`, the three Langfuse vars and both
 * provider keys empty on purpose — `instrumentation.ts` and `startWorker()` register neither
 * when unset — so an empty value is a declared local state and only a name that is not there
 * at all is a gap.
 */
function missingEnv(app: ResolvedApp): CheckFinding[] {
  const missing = app.declared.filter((name) => !(name in app.env));
  return missing.length === 0
    ? []
    : [{ code: "env", message: `unset: ${missing.join(", ")}` }];
}

async function pendingMigrations(app: ResolvedApp, migratorUrl: string): Promise<CheckFinding[]> {
  const client = new Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    const findings: CheckFinding[] = [];
    const sets: { what: string; dir: string; table: string }[] = [
      { what: "core", dir: CORE_MIGRATIONS_DIR, table: CORE_MIGRATIONS_TABLE },
      { what: "app", dir: app.migrationsDir, table: APP_MIGRATIONS_TABLE },
    ];

    for (const set of sets) {
      const inTree = await journalLength(set.dir);
      const applied = await appliedCount(client, set.table);
      if (inTree > applied) {
        findings.push({
          code: "migrations",
          message: `${inTree - applied} ${set.what} migration(s) pending; run hf migrate`,
        });
      }
    }
    return findings;
  } finally {
    await client.end();
  }
}

async function journalLength(dir: string): Promise<number> {
  try {
    const journal = JSON.parse(
      await readFile(path.join(dir, "meta", "_journal.json"), "utf8"),
    ) as { entries?: unknown[] };
    return journal.entries?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * A missing table is "none applied", which is the state of a database nobody has migrated.
 * Two round trips rather than one `CASE`: Postgres parses the whole statement before it
 * evaluates any of it, so a branch naming a relation that does not exist still fails.
 */
async function appliedCount(client: Client, table: string): Promise<number> {
  const { rows: present } = await client.query<{ oid: string | null }>(
    "SELECT to_regclass($1)::text AS oid",
    [`drizzle.${table}`],
  );
  if (present[0]?.oid === null) return 0;

  const { rows } = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM drizzle.${table}`,
  );
  return rows[0]?.count ?? 0;
}
