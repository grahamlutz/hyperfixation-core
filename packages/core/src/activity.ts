import { assertNotInWorkflow } from "@hyperfixation/db";
import type { StepContext } from "@hyperfixation/workflows";
import type { ClientBase, Pool } from "pg";
import { stepClient } from "./step-client.js";

export const ACTIVITY_LIST_OPERATION = "activity.list";

/** `<noun>.<verb>`, the shape `action.uncertain` and `approval.<decision>` already write. */
export const ACTIVITY_KIND_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export class InvalidActivityKind extends Error {
  readonly kind: string;

  constructor(kind: string) {
    super(
      `InvalidActivityKind: ${JSON.stringify(kind)} is not a <noun>.<verb> activity kind, ` +
        "as 'task.created' and 'action.uncertain' are",
    );
    this.name = "InvalidActivityKind";
    this.kind = kind;
  }
}

/**
 * `DO NOTHING` on the partial `(run_id, key)` index: a step re-run under a second attempt writes
 * the same key and adds nothing, which is what makes every step-side write in this package
 * replay-safe. A web-side write passes `key` null, no conflict can fire, and the row is added.
 */
export const INSERT_ACTIVITY_STATEMENT =
  "INSERT INTO hf_activity (record_type, record_id, kind, actor_id, body, meta, run_id, key) " +
  "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8) " +
  "ON CONFLICT (run_id, key) WHERE key IS NOT NULL DO NOTHING RETURNING id";

export const EXISTING_ACTIVITY_STATEMENT =
  "SELECT id FROM hf_activity WHERE run_id = $1 AND key = $2";

const LIST_ACTIVITY_STATEMENT =
  "SELECT id, record_type, record_id, kind, actor_id, body, meta, run_id, at FROM hf_activity " +
  "WHERE record_type = $1 AND record_id = $2 ORDER BY at, id";

/** The whole row, as any writer in this package supplies it. */
export interface ActivityWrite {
  kind: string;
  recordType?: string | null;
  recordId?: string | number | null;
  actorId?: string | null;
  body?: string | null;
  meta?: unknown;
  runId?: string | null;
  key?: string | null;
}

export interface ActivityRecorded {
  id: number;
  /** False when a replay found the row its own key had already written. */
  created: boolean;
}

/** What a flow records: the run and the key come from the step, not from the caller. */
export interface ActivityRecordOptions {
  kind: string;
  recordType?: string;
  recordId?: string | number;
  actorId?: string;
  body?: string;
  meta?: unknown;
  /** Distinguishes two rows written by one step; defaults to the step's key and the kind. */
  key?: string;
}

export interface ActivityListOptions {
  recordType: string;
  recordId: string | number;
}

export interface ActivityRow {
  id: number;
  recordType: string | null;
  recordId: string | null;
  kind: string;
  actorId: string | null;
  body: string | null;
  meta: unknown;
  /** Null for a web-side write; C6's timeline groups those under "manual". */
  runId: string | null;
  at: Date;
}

interface ActivityQueryRow {
  id: string;
  record_type: string | null;
  record_id: string | null;
  kind: string;
  actor_id: string | null;
  body: string | null;
  meta: unknown;
  run_id: string | null;
  at: Date;
}

export function assertActivityKind(kind: string): void {
  if (!ACTIVITY_KIND_PATTERN.test(kind)) throw new InvalidActivityKind(kind);
}

/**
 * The one `hf_activity` writer in this package — tasks, labels, outcomes, scores and
 * `records.archive()` all go through it, on whatever client their own transaction already holds.
 */
export async function insertActivity(
  queryable: Pool | ClientBase,
  write: ActivityWrite,
): Promise<ActivityRecorded> {
  assertActivityKind(write.kind);

  const runId = write.runId ?? null;
  const key = write.key ?? null;
  const inserted = await queryable.query<{ id: string }>(INSERT_ACTIVITY_STATEMENT, [
    write.recordType ?? null,
    write.recordId === undefined || write.recordId === null ? null : String(write.recordId),
    write.kind,
    write.actorId ?? null,
    write.body ?? null,
    write.meta === undefined ? null : JSON.stringify(write.meta),
    runId,
    key,
  ]);
  if (inserted.rows[0] !== undefined) return { id: Number(inserted.rows[0].id), created: true };

  const found = await queryable.query<{ id: string }>(EXISTING_ACTIVITY_STATEMENT, [runId, key]);
  return { id: Number(found.rows[0]!.id), created: false };
}

/**
 * A flow's own timeline entry, written inside `ctx.tx` so it commits with whatever else the step
 * wrote. The default key is the step's, which makes one row per step per kind: a step that wants
 * two rows of one kind names them itself.
 */
export async function recordActivity(
  ctx: StepContext,
  options: ActivityRecordOptions,
): Promise<ActivityRecorded> {
  assertActivityKind(options.kind);
  return ctx.tx((db) =>
    insertActivity(stepClient(db), {
      ...options,
      runId: ctx.runId,
      key: options.key ?? `${ctx.key}:${options.kind}`,
    }),
  );
}

/** A control-plane read: `run_id` travels with the row so the timeline can group by it. */
export async function listActivity(
  pool: Pool,
  options: ActivityListOptions,
): Promise<ActivityRow[]> {
  assertNotInWorkflow(ACTIVITY_LIST_OPERATION);
  const { rows } = await pool.query<ActivityQueryRow>(LIST_ACTIVITY_STATEMENT, [
    options.recordType,
    String(options.recordId),
  ]);
  return rows.map((row) => ({
    id: Number(row.id),
    recordType: row.record_type,
    recordId: row.record_id,
    kind: row.kind,
    actorId: row.actor_id,
    body: row.body,
    meta: row.meta,
    runId: row.run_id,
    at: row.at,
  }));
}
