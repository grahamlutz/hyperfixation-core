import type { Client } from "pg";
import { quoteIdent } from "./roles.js";

/**
 * Machinery tables that point at an app record through `(record_type, record_id)`
 * and whose history is meant to outlive the record. There is deliberately no
 * foreign key — the core cannot know an app's tables at migration time — so the
 * delete-guard trigger is the only thing standing between a hard `DELETE` and a
 * lost approval, link, label or outcome.
 */
export const DELETE_GUARD_REFERENCING_TABLES = [
  "hf_approval",
  "hf_record_link",
  "hf_label",
  "hf_outcome",
] as const;

export const DELETE_GUARD_FUNCTION = "hf_delete_guard";

export interface RecordTable {
  /** The app table carrying a `bigint` identity primary key named `id`. */
  table: string;
  /** The name the app registered with `defineRecord`; machinery rows store it. */
  recordType: string;
}

export interface DeleteGuardResult {
  referencingTables: string[];
  guardedTables: string[];
}

/**
 * Installs `hf_delete_guard()` and a `BEFORE DELETE` trigger on every registered
 * record table. `records.archive()` is the supported path for making a record go
 * away; a hard `DELETE` of a referenced record raises `restrict_violation`.
 *
 * The function body is regenerated on every deploy from the referencing tables
 * that exist *now*: plpgsql bodies are validated at `CREATE FUNCTION` time, so a
 * body naming a machinery table a later phase has not added yet would fail to
 * install at all.
 */
export async function installDeleteGuards(
  client: Client,
  recordTables: readonly RecordTable[] = [],
): Promise<DeleteGuardResult> {
  const referencingTables = await existingReferencingTables(client);
  await client.query(deleteGuardFunctionSql(referencingTables));

  for (const { table, recordType } of recordTables) {
    const ident = quoteIdent(table);
    await client.query(`DROP TRIGGER IF EXISTS ${quoteIdent(DELETE_GUARD_FUNCTION)} ON ${ident}`);
    await client.query(
      `CREATE TRIGGER ${quoteIdent(DELETE_GUARD_FUNCTION)} BEFORE DELETE ON ${ident} ` +
        `FOR EACH ROW EXECUTE FUNCTION ${quoteIdent(DELETE_GUARD_FUNCTION)}('${recordType.replace(/'/g, "''")}')`,
    );
  }

  return { referencingTables, guardedTables: recordTables.map((r) => r.table) };
}

async function existingReferencingTables(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])
      ORDER BY c.relname`,
    [[...DELETE_GUARD_REFERENCING_TABLES]],
  );
  return rows.map((r) => r.table_name);
}

export function deleteGuardFunctionSql(referencingTables: readonly string[]): string {
  const checks = referencingTables
    .map(
      // `record_id` is text on every machinery table — a record id is carried, not joined on —
      // while a record table's `id` is the bigint identity E001 insists on.
      (t) => `  IF EXISTS (SELECT 1 FROM ${quoteIdent(t)} WHERE record_type = TG_ARGV[0] AND record_id = OLD.id::text) THEN
    RAISE EXCEPTION 'delete-guard: % % is referenced by ${t}; use records.archive()', TG_ARGV[0], OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;`,
    )
    .join("\n");

  return `CREATE OR REPLACE FUNCTION ${quoteIdent(DELETE_GUARD_FUNCTION)}() RETURNS trigger
LANGUAGE plpgsql AS $hf_delete_guard$
BEGIN
${checks}
  RETURN OLD;
END;
$hf_delete_guard$`;
}
