import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { parse, type Statement } from "pgsql-ast-parser";
import type { RecordTable } from "./delete-guard.js";

export type BootCheckCode = "E001" | "E002" | "E003" | "E004" | "E005" | "E006";

export const BOOT_CHECK_CODES: readonly BootCheckCode[] = [
  "E001",
  "E002",
  "E003",
  "E004",
  "E005",
  "E006",
];

export class BootCheckFailure extends Error {
  readonly code: BootCheckCode;
  readonly details: readonly string[];

  constructor(code: BootCheckCode, summary: string, details: readonly string[] = []) {
    super(`${code}: ${summary}${details.length > 0 ? `\n  - ${details.join("\n  - ")}` : ""}`);
    this.name = "BootCheckFailure";
    this.code = code;
    this.details = details;
  }
}

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface BootCheckOptions {
  /** Connection the process itself uses — for `web` and `worker`, the application role. */
  databaseUrl: string;
  /** Tables registered with `defineRecord`; empty until an app exists. */
  recordTables?: readonly RecordTable[];
  /** Directory of the app's own migrations, for E005. */
  appMigrationsDir?: string;
}

/**
 * E001–E006 in order, as the first statements of `startWorker()` and
 * `getClient()`. Throws `BootCheckFailure` naming the first check that fails.
 */
export async function runBootChecks(options: BootCheckOptions): Promise<void> {
  const recordTables = options.recordTables ?? [];
  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    await checkE001(client, recordTables);
    await checkE002(client, recordTables);
    await checkE003(client, recordTables);
    await checkE004(client);
    await checkE005(options.appMigrationsDir);
    await checkE006(client);
  } finally {
    await client.end();
  }
}

/** E001 — every registered record table has a `bigint` identity primary key named `id`. */
export async function checkE001(
  db: Queryable,
  recordTables: readonly RecordTable[],
): Promise<void> {
  const failures: string[] = [];
  for (const { table } of recordTables) {
    const { rows } = (await db.query(
      `SELECT a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type,
              a.attidentity AS identity
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
        WHERE n.nspname = 'public' AND c.relname = $1 AND i.indisprimary`,
      [table],
    )) as { rows: { name: string; type: string; identity: string }[] };

    if (rows.length === 0) {
      failures.push(`${table}: no primary key (or the table does not exist)`);
      continue;
    }
    if (rows.length > 1) {
      failures.push(`${table}: composite primary key (${rows.map((r) => r.name).join(", ")})`);
      continue;
    }
    const [pk] = rows as [{ name: string; type: string; identity: string }];
    if (pk.name !== "id") failures.push(`${table}: primary key is "${pk.name}", not "id"`);
    else if (pk.type !== "bigint") failures.push(`${table}: id is ${pk.type}, not bigint`);
    else if (pk.identity !== "a" && pk.identity !== "d") {
      failures.push(`${table}: id is not an identity column`);
    }
  }
  if (failures.length > 0) {
    throw new BootCheckFailure(
      "E001",
      "a registered record table has no bigint identity primary key named id",
      failures,
    );
  }
}

/** E002 — every `record_type` stored in a machinery table is registered. */
export async function checkE002(
  db: Queryable,
  recordTables: readonly RecordTable[],
): Promise<void> {
  const registered = new Set(recordTables.map((r) => r.recordType));
  const { rows: tableRows } = (await db.query(
    `SELECT c.relname AS table_name
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND a.attname = 'record_type' AND a.attnum > 0 AND NOT a.attisdropped
        AND c.relname LIKE 'hf\\_%'
      ORDER BY c.relname`,
  )) as { rows: { table_name: string }[] };

  const failures: string[] = [];
  for (const { table_name } of tableRows) {
    // A null `record_type` is a row attached to no record — every `hf_run` that is not about
    // one — not a row naming a type nobody registered.
    const { rows } = (await db.query(
      `SELECT DISTINCT record_type FROM "${table_name.replace(/"/g, '""')}" WHERE record_type IS NOT NULL`,
    )) as { rows: { record_type: string }[] };
    for (const { record_type } of rows) {
      if (!registered.has(record_type)) failures.push(`${table_name}: "${record_type}"`);
    }
  }
  if (failures.length > 0) {
    throw new BootCheckFailure(
      "E002",
      "a machinery row references a record type no app registered",
      failures,
    );
  }
}

/** E003 — every registered record table has the trigram index on `normalized_name`. */
export async function checkE003(
  db: Queryable,
  recordTables: readonly RecordTable[],
): Promise<void> {
  const failures: string[] = [];
  for (const { table } of recordTables) {
    const { rows } = (await db.query(
      `SELECT 1
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_class ic ON ic.oid = i.indexrelid
         JOIN pg_am am ON am.oid = ic.relam
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1 AND am.amname = 'gin'
          AND pg_get_indexdef(i.indexrelid) ILIKE '%normalized\\_name%gin\\_trgm\\_ops%'`,
      [table],
    )) as { rows: unknown[] };
    if (rows.length === 0) {
      failures.push(`${table}: no GIN index on normalized_name using gin_trgm_ops`);
    }
  }
  if (failures.length > 0) {
    throw new BootCheckFailure(
      "E003",
      "a registered record table is missing its trigram index",
      failures,
    );
  }
}

/** E004 — no app table references an `hf_*` table with a foreign key. */
export async function checkE004(db: Queryable): Promise<void> {
  const { rows } = (await db.query(
    `SELECT con.conname AS constraint_name,
            child.relname AS referencing,
            parent.relname AS referenced
       FROM pg_constraint con
       JOIN pg_class child ON child.oid = con.conrelid
       JOIN pg_class parent ON parent.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = child.relnamespace
      WHERE con.contype = 'f' AND n.nspname = 'public'
        AND parent.relname LIKE 'hf\\_%' AND child.relname NOT LIKE 'hf\\_%'
      ORDER BY con.conname`,
  )) as { rows: { constraint_name: string; referencing: string; referenced: string }[] };

  if (rows.length > 0) {
    throw new BootCheckFailure(
      "E004",
      "an app table has a foreign key into an hf_* table",
      rows.map((r) => `${r.referencing} -> ${r.referenced} (${r.constraint_name})`),
    );
  }
}

/** E005 — no app migration creates, alters or drops an `hf_*` table. */
export async function checkE005(appMigrationsDir?: string): Promise<void> {
  if (appMigrationsDir === undefined) return;

  const failures: string[] = [];
  for (const file of await migrationFiles(appMigrationsDir)) {
    const sql = await readFile(path.join(appMigrationsDir, file), "utf8");
    for (const statement of splitStatements(sql)) {
      let parsed: Statement[];
      try {
        parsed = parse(statement);
      } catch (cause) {
        failures.push(`${file}: unparseable statement (${(cause as Error).message})`);
        continue;
      }
      for (const name of parsed.flatMap(hfTablesTouched)) {
        failures.push(`${file}: ${name}`);
      }
    }
  }
  if (failures.length > 0) {
    throw new BootCheckFailure(
      "E005",
      "an app migration creates, alters or drops an hf_* table",
      failures,
    );
  }
}

/**
 * E006 — the application role has `USAGE` on schema `dbos` and `INSERT` on
 * `dbos.workflow_status`.
 *
 * Only the migrator's `dbos schema -s dbos -r hf_<app>` step grants these; the
 * SDK's own system-database migrations contain no `GRANT` at all. Without it the
 * worker dies at `DBOS.launch` with a bare `42501`, and `enqueueInTransaction`
 * raises it from inside somebody's open transaction. So this runs before any
 * statement that could hit `dbos.*`, and it reads privileges rather than
 * exercising them.
 *
 * Two traps in reading them, both of which raise the very error the check exists
 * to preempt: `has_*_privilege` on a missing schema raises `3F000`, and
 * `to_regclass('dbos.workflow_status')` raises `42501` when the role has no
 * `USAGE` on `dbos`, because resolving a qualified name needs the schema. Hence
 * the nested `CASE` — arms are evaluated lazily, so the table lookup is never
 * reached without `USAGE` — and the catch. The process must fail naming E006,
 * never with a raw permission error.
 */
export async function checkE006(db: Queryable): Promise<void> {
  const failures: string[] = [];
  try {
    const { rows } = (await db.query(
      `SELECT CASE WHEN to_regnamespace('dbos') IS NULL THEN false
                   ELSE has_schema_privilege('dbos', 'USAGE') END AS schema_usage,
              CASE WHEN to_regnamespace('dbos') IS NULL THEN false
                   WHEN NOT has_schema_privilege('dbos', 'USAGE') THEN false
                   WHEN to_regclass('dbos.workflow_status') IS NULL THEN false
                   ELSE has_table_privilege('dbos.workflow_status', 'INSERT') END AS table_insert`,
    )) as { rows: { schema_usage: boolean; table_insert: boolean }[] };
    const [row] = rows as [{ schema_usage: boolean; table_insert: boolean }];
    if (!row.schema_usage) failures.push("has_schema_privilege('dbos', 'USAGE') is false");
    if (!row.table_insert) {
      failures.push("has_table_privilege('dbos.workflow_status', 'INSERT') is false");
    }
  } catch (cause) {
    failures.push(`privilege lookup failed: ${(cause as Error).message}`);
  }

  if (failures.length > 0) {
    throw new BootCheckFailure(
      "E006",
      "the application role lacks its dbos grants; run `dbos schema -s dbos -r <app role>`",
      failures,
    );
  }
}

function hfTablesTouched(node: Statement): string[] {
  switch (node.type) {
    case "create table":
      return isHfTable(node.name.name) ? [`CREATE TABLE ${node.name.name}`] : [];
    case "alter table":
      return isHfTable(node.table.name) ? [`ALTER TABLE ${node.table.name}`] : [];
    case "drop table":
      return node.names.filter((n) => isHfTable(n.name)).map((n) => `DROP TABLE ${n.name}`);
    default:
      return [];
  }
}

function isHfTable(name: string): boolean {
  return name.toLowerCase().startsWith("hf_");
}

async function migrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
