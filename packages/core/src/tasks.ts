import { assertNotInWorkflow, controlPlaneTx, type RecordTable } from "@hyperfixation/db";
import type { StepContext } from "@hyperfixation/workflows";
import type { ClientBase, Pool } from "pg";
import { insertActivity } from "./activity.js";
import type { Registry } from "./registry.js";
import { stepClient } from "./step-client.js";

export const TASK_CREATE_MANUAL_OPERATION = "tasks.createManual";
export const TASK_COMPLETE_OPERATION = "tasks.complete";
export const TASK_CANCEL_OPERATION = "tasks.cancel";
export const TASK_LIST_OPERATION = "tasks.list";

const INSERT_TASK_STATEMENT =
  "INSERT INTO hf_task (record_type, record_id, title, due_at, owner_id, origin, origin_ref) " +
  "VALUES ($1, $2, $3, $4, $5, $6, $7) " +
  "ON CONFLICT (origin, origin_ref) WHERE origin_ref IS NOT NULL DO NOTHING RETURNING id";

const EXISTING_TASK_STATEMENT =
  "SELECT id FROM hf_task WHERE origin = $1 AND origin_ref = $2 ORDER BY id LIMIT 1";

/** Only an open task closes; a second call changes nothing and writes no activity row. */
const CLOSE_TASK_STATEMENT = (column: "done_at" | "cancelled_at"): string =>
  `UPDATE hf_task SET ${column} = now() WHERE id = $1 AND done_at IS NULL AND cancelled_at IS NULL ` +
  "RETURNING record_type, record_id";

const CANCEL_OPEN_TASKS_STATEMENT =
  "UPDATE hf_task SET cancelled_at = now() WHERE record_type = $1 AND record_id = $2 " +
  "AND done_at IS NULL AND cancelled_at IS NULL RETURNING id";

/** The columns `taskRowOf` maps, shared with the workspace's own `hf_task` reads. */
export const TASK_COLUMNS =
  "id, record_type, record_id, title, due_at, owner_id, done_at, cancelled_at, origin, created_at";

// One statement for every filter combination: a null parameter is "no filter", which keeps the
// shape of the query — and so its plan — the same however the workspace calls it.
const LIST_TASKS_STATEMENT =
  `SELECT ${TASK_COLUMNS} FROM hf_task WHERE ($1::text IS NULL OR record_type = $1) ` +
  "AND ($2::text IS NULL OR record_id = $2) AND ($3::text IS NULL OR owner_id = $3) " +
  "AND ($4::boolean IS NULL OR (done_at IS NULL AND cancelled_at IS NULL) = $4) ORDER BY id";

export interface TaskTarget {
  recordType?: string;
  recordId?: string | number;
}

export interface TaskCreateOptions extends TaskTarget {
  title: string;
  dueAt?: Date;
  ownerId?: string;
  /** Distinguishes two tasks one step opens; defaults to the step's key. */
  key?: string;
}

export interface TaskCreateManualOptions extends TaskTarget {
  title: string;
  dueAt?: Date;
  ownerId?: string;
  userId?: string;
}

export interface TaskCreated {
  id: number;
  /** False when a replay found the task its own `origin_ref` had already opened. */
  created: boolean;
}

export interface TaskCloseOptions {
  id: number;
  userId?: string;
}

export interface TaskClosed {
  id: number;
  /** False when the task was already done or cancelled; nothing was written. */
  changed: boolean;
}

export interface TaskListOptions {
  recordType?: string;
  recordId?: string | number;
  ownerId?: string;
  /** True for tasks neither done nor cancelled, false for the rest, omitted for both. */
  open?: boolean;
}

export interface TaskRow {
  id: number;
  recordType: string | null;
  recordId: string | null;
  title: string;
  dueAt: Date | null;
  ownerId: string | null;
  doneAt: Date | null;
  cancelledAt: Date | null;
  origin: string;
  createdAt: Date;
}

export interface TaskQueryRow {
  id: string;
  record_type: string | null;
  record_id: string | null;
  title: string;
  due_at: Date | null;
  owner_id: string | null;
  done_at: Date | null;
  cancelled_at: Date | null;
  origin: string;
  created_at: Date;
}

/**
 * The colon keeps a flow task's `origin_ref` disjoint from `actions.perform`'s, which is the bare
 * `hf_action_log` id on the same partial unique index.
 */
export function flowOriginRef(runId: string, key: string): string {
  return `${runId}:${key}`;
}

/**
 * A task a flow opens, inside `ctx.tx`. Keyed by `(run_id, step key)` through `origin_ref`, so
 * attempt 2 re-running the step finds its own task rather than opening a second one.
 *
 * The record type is checked against the registry here rather than at the next boot: a task
 * carrying a `record_type` no app registers is what E002 refuses.
 */
export async function createTask(
  ctx: StepContext,
  records: Registry<RecordTable>,
  options: TaskCreateOptions,
): Promise<TaskCreated> {
  const target = requireTarget(records, options);
  const key = options.key ?? ctx.key;
  const originRef = flowOriginRef(ctx.runId, key);

  return ctx.tx(async (db) => {
    const client = stepClient(db);
    const task = await insertTask(client, options, "flow", originRef);
    // Written whether or not the insert conflicted: its own key is what makes it once-only.
    await insertActivity(client, {
      ...target,
      kind: "task.created",
      runId: ctx.runId,
      key: `${key}:task.created`,
      meta: { taskId: task.id, origin: "flow", originRef, title: options.title },
    });
    return task;
  });
}

/** A task a human opens from the workspace: no run, no `origin_ref`, so no replay to survive. */
export async function createManualTask(
  pool: Pool,
  records: Registry<RecordTable>,
  options: TaskCreateManualOptions,
): Promise<TaskCreated> {
  const target = requireTarget(records, options);
  return controlPlaneTx(pool, { operation: TASK_CREATE_MANUAL_OPERATION }, async (work) => {
    const task = await insertTask(work, options, "manual", null);
    await insertActivity(work, {
      ...target,
      kind: "task.created",
      actorId: options.userId ?? null,
      meta: { taskId: task.id, origin: "manual", title: options.title },
    });
    return task;
  });
}

export function completeTask(pool: Pool, options: TaskCloseOptions): Promise<TaskClosed> {
  return closeTask(pool, options, TASK_COMPLETE_OPERATION, "done_at", "task.completed");
}

export function cancelTask(pool: Pool, options: TaskCloseOptions): Promise<TaskClosed> {
  return closeTask(pool, options, TASK_CANCEL_OPERATION, "cancelled_at", "task.cancelled");
}

export async function listTasks(pool: Pool, options: TaskListOptions = {}): Promise<TaskRow[]> {
  assertNotInWorkflow(TASK_LIST_OPERATION);
  const { rows } = await pool.query<TaskQueryRow>(LIST_TASKS_STATEMENT, [
    options.recordType ?? null,
    options.recordId === undefined ? null : String(options.recordId),
    options.ownerId ?? null,
    options.open ?? null,
  ]);
  return rows.map(taskRowOf);
}

export function taskRowOf(row: TaskQueryRow): TaskRow {
  return {
    id: Number(row.id),
    recordType: row.record_type,
    recordId: row.record_id,
    title: row.title,
    dueAt: row.due_at,
    ownerId: row.owner_id,
    doneAt: row.done_at,
    cancelledAt: row.cancelled_at,
    origin: row.origin,
    createdAt: row.created_at,
  };
}

/**
 * Every open task on a record, cancelled in one statement. Called from inside
 * `records.archive()`'s transaction, which already holds the record's own row.
 */
export async function cancelOpenTasksForRecord(
  queryable: Pool | ClientBase,
  recordType: string,
  recordId: string,
): Promise<number[]> {
  const { rows } = await queryable.query<{ id: string }>(CANCEL_OPEN_TASKS_STATEMENT, [
    recordType,
    recordId,
  ]);
  return rows.map((row) => Number(row.id));
}

async function closeTask(
  pool: Pool,
  options: TaskCloseOptions,
  operation: string,
  column: "done_at" | "cancelled_at",
  kind: string,
): Promise<TaskClosed> {
  return controlPlaneTx(pool, { operation }, async (work) => {
    const closed = await work.query<{ record_type: string | null; record_id: string | null }>(
      CLOSE_TASK_STATEMENT(column),
      [options.id],
    );
    const row = closed.rows[0];
    if (row === undefined) return { id: options.id, changed: false };

    await insertActivity(work, {
      recordType: row.record_type,
      recordId: row.record_id,
      kind,
      actorId: options.userId ?? null,
      meta: { taskId: options.id },
    });
    return { id: options.id, changed: true };
  });
}

async function insertTask(
  queryable: Pool | ClientBase,
  options: TaskCreateOptions | TaskCreateManualOptions,
  origin: "flow" | "manual",
  originRef: string | null,
): Promise<TaskCreated> {
  const inserted = await queryable.query<{ id: string }>(INSERT_TASK_STATEMENT, [
    options.recordType ?? null,
    options.recordId === undefined ? null : String(options.recordId),
    options.title,
    options.dueAt ?? null,
    options.ownerId ?? null,
    origin,
    originRef,
  ]);
  if (inserted.rows[0] !== undefined) return { id: Number(inserted.rows[0].id), created: true };

  const found = await queryable.query<{ id: string }>(EXISTING_TASK_STATEMENT, [origin, originRef]);
  return { id: Number(found.rows[0]!.id), created: false };
}

/** A task may carry no record; one that names a type must name a registered one. */
function requireTarget(records: Registry<RecordTable>, options: TaskTarget): TaskTarget {
  if (options.recordType === undefined) return {};
  records.require(options.recordType);
  return {
    recordType: options.recordType,
    ...(options.recordId === undefined ? {} : { recordId: String(options.recordId) }),
  };
}
