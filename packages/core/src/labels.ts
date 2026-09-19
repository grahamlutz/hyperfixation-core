import {
  assertNotInWorkflow,
  controlPlaneTx,
  type LabelTarget,
  type LabelValue,
  type RecordTable,
} from "@hyperfixation/db";
import type { Pool } from "pg";
import { insertActivity } from "./activity.js";
import type { Registry } from "./registry.js";

export const LABEL_ADD_OPERATION = "labels.add";
export const LABEL_LIST_OPERATION = "labels.list";

const INSERT_LABEL_STATEMENT =
  "INSERT INTO hf_label (record_type, record_id, target, target_id, value, correction, user_id) " +
  "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id";

const LIST_LABELS_STATEMENT =
  "SELECT id, record_type, record_id, target, target_id, value, correction, user_id, created_at " +
  "FROM hf_label WHERE record_type = $1 AND record_id = $2 ORDER BY created_at, id";

export interface LabelAddOptions {
  recordType: string;
  recordId: string | number;
  target: LabelTarget;
  /** Which score or draft the label is about; null for a label on the record itself. */
  targetId?: string | number;
  value: LabelValue;
  correction?: unknown;
  userId?: string;
}

export interface LabelListOptions {
  recordType: string;
  recordId: string | number;
}

export interface LabelRow {
  id: number;
  recordType: string;
  recordId: string;
  target: LabelTarget;
  targetId: string | null;
  value: LabelValue;
  correction: unknown;
  userId: string | null;
  createdAt: Date;
}

interface LabelQueryRow {
  id: string;
  record_type: string;
  record_id: string;
  target: LabelTarget;
  target_id: string | null;
  value: LabelValue;
  correction: unknown;
  user_id: string | null;
  created_at: Date;
}

/**
 * A human's feedback on a score, a draft or the record, always from the web: `hf_label` is what
 * the scorer's next spec version is argued from, and nothing in a run produces one.
 *
 * The record type is required and registered — the row's `record_type` is NOT NULL, and an
 * unregistered value is what E002 refuses at the next boot.
 */
export async function addLabel(
  pool: Pool,
  records: Registry<RecordTable>,
  options: LabelAddOptions,
): Promise<{ id: number }> {
  records.require(options.recordType);
  const recordId = String(options.recordId);

  return controlPlaneTx(pool, { operation: LABEL_ADD_OPERATION }, async (work) => {
    const { rows } = await work.query<{ id: string }>(INSERT_LABEL_STATEMENT, [
      options.recordType,
      recordId,
      options.target,
      options.targetId === undefined ? null : String(options.targetId),
      options.value,
      options.correction === undefined ? null : JSON.stringify(options.correction),
      options.userId ?? null,
    ]);
    const id = Number(rows[0]!.id);
    await insertActivity(work, {
      recordType: options.recordType,
      recordId,
      kind: "label.added",
      actorId: options.userId ?? null,
      meta: {
        labelId: id,
        target: options.target,
        targetId: options.targetId === undefined ? null : String(options.targetId),
        value: options.value,
      },
    });
    return { id };
  });
}

export async function listLabels(pool: Pool, options: LabelListOptions): Promise<LabelRow[]> {
  assertNotInWorkflow(LABEL_LIST_OPERATION);
  const { rows } = await pool.query<LabelQueryRow>(LIST_LABELS_STATEMENT, [
    options.recordType,
    String(options.recordId),
  ]);
  return rows.map((row) => ({
    id: Number(row.id),
    recordType: row.record_type,
    recordId: row.record_id,
    target: row.target,
    targetId: row.target_id,
    value: row.value,
    correction: row.correction,
    userId: row.user_id,
    createdAt: row.created_at,
  }));
}
