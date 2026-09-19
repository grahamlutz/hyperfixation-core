import { assertNotInWorkflow, controlPlaneTx, type RecordTable } from "@hyperfixation/db";
import type { Pool } from "pg";
import { insertActivity } from "./activity.js";
import type { Registry } from "./registry.js";

export const OUTCOME_RECORD_OPERATION = "outcomes.record";
export const OUTCOME_LIST_OPERATION = "outcomes.list";

const INSERT_OUTCOME_STATEMENT =
  "INSERT INTO hf_outcome (record_type, record_id, outcome, at, notes) " +
  "VALUES ($1, $2, $3, COALESCE($4, now()), $5) RETURNING id";

const LIST_OUTCOMES_STATEMENT =
  "SELECT id, record_type, record_id, outcome, at, notes FROM hf_outcome " +
  "WHERE record_type = $1 AND record_id = $2 ORDER BY at, id";

export interface OutcomeRecordOptions {
  recordType: string;
  recordId: string | number;
  /** The app's own vocabulary — what happened, not how it was scored. */
  outcome: string;
  /** When it happened, if that is not now; an outcome is often learned after the fact. */
  at?: Date;
  notes?: string;
  userId?: string;
}

export interface OutcomeListOptions {
  recordType: string;
  recordId: string | number;
}

export interface OutcomeRow {
  id: number;
  recordType: string;
  recordId: string;
  outcome: string;
  at: Date;
  notes: string | null;
}

interface OutcomeQueryRow {
  id: string;
  record_type: string;
  record_id: string;
  outcome: string;
  at: Date;
  notes: string | null;
}

/**
 * What became of a record, from the web. Unlike a score it is never derived: a flow that thinks
 * it knows an outcome is asserting a fact about the world, which is a human's to record.
 */
export async function recordOutcome(
  pool: Pool,
  records: Registry<RecordTable>,
  options: OutcomeRecordOptions,
): Promise<{ id: number }> {
  records.require(options.recordType);
  const recordId = String(options.recordId);

  return controlPlaneTx(pool, { operation: OUTCOME_RECORD_OPERATION }, async (work) => {
    const { rows } = await work.query<{ id: string }>(INSERT_OUTCOME_STATEMENT, [
      options.recordType,
      recordId,
      options.outcome,
      options.at ?? null,
      options.notes ?? null,
    ]);
    const id = Number(rows[0]!.id);
    await insertActivity(work, {
      recordType: options.recordType,
      recordId,
      kind: "outcome.recorded",
      actorId: options.userId ?? null,
      body: options.notes ?? null,
      meta: { outcomeId: id, outcome: options.outcome },
    });
    return { id };
  });
}

export async function listOutcomes(pool: Pool, options: OutcomeListOptions): Promise<OutcomeRow[]> {
  assertNotInWorkflow(OUTCOME_LIST_OPERATION);
  const { rows } = await pool.query<OutcomeQueryRow>(LIST_OUTCOMES_STATEMENT, [
    options.recordType,
    String(options.recordId),
  ]);
  return rows.map((row) => ({
    id: Number(row.id),
    recordType: row.record_type,
    recordId: row.record_id,
    outcome: row.outcome,
    at: row.at,
    notes: row.notes,
  }));
}
