import type { StepDatabase } from "@hyperfixation/db";
import { sql } from "drizzle-orm";
import type { StepContext } from "./step.js";

/** What a channel is handed. `idempotencyKey` is stable across attempts, so a provider that
 * supports one dedupes a re-send rather than sending twice. */
export interface ActionDispatch<Req = unknown> {
  idempotencyKey: string;
  runId: string;
  key: string;
  request: Req;
}

export interface ActionResult {
  externalId?: string;
  response?: unknown;
}

/** `Req` is what this channel is sent; left off, a channel takes `unknown` as it always has. */
export interface ActionChannel<Req = unknown> {
  readonly name: string;
  /** Whether a re-send with the same `idempotencyKey` is delivered at most once by the provider. */
  readonly dedupes: boolean;
  /**
   * How long the provider honours that `idempotencyKey`, measured from the row's first attempt.
   * Left off, the dedupe never expires — a provider keying on a nonce it keeps, or a channel that
   * dispatches nothing. A `dedupes: true` channel whose provider *does* forget must declare its
   * window, or a re-entry past it is a second delivery.
   */
  readonly dedupeWindowMs?: number;
  send(dispatch: ActionDispatch<Req>): Promise<ActionResult>;
}

export interface ActionsPerformOptions<Req = unknown> {
  /** Unique within the run and stable across attempts, exactly as `llm.run`'s is. */
  key: string;
  channel: ActionChannel<Req>;
  request?: Req;
  recordType?: string;
  recordId?: string;
}

interface ActionRow extends Record<string, unknown> {
  id: string;
  status: string;
  external_id: string | null;
  response: unknown;
  record_type: string | null;
  record_id: string | null;
  /** Age of the row's first attempt, on the database's clock rather than any worker's. */
  age_ms: number;
}

/**
 * A row left in flight by an attempt that is gone, on a channel that cannot dedupe: nothing was
 * re-sent and an `hf_task` asks a human whether the first send went out. Terminal by design — it
 * reaches the flow wrapper's catch and the run ends `failed`, because no code can decide this.
 *
 * `taskId` is null only for a row that went `uncertain` before this package opened tasks for it.
 */
export class ActionUncertain extends Error {
  readonly runId: string;
  readonly key: string;
  readonly actionLogId: number;
  readonly taskId: number | null;

  constructor(runId: string, key: string, actionLogId: number, taskId: number | null) {
    super(
      `ActionUncertain: action ${key} on run ${runId} (hf_action_log ${actionLogId}) was left ` +
        "in flight by an attempt that is gone and its channel cannot dedupe; nothing was " +
        `re-sent and hf_task ${taskId ?? "(none)"} asks a human to confirm`,
    );
    this.name = "ActionUncertain";
    this.runId = runId;
    this.key = key;
    this.actionLogId = actionLogId;
    this.taskId = taskId;
  }
}

export function idempotencyKey(runId: string, key: string): string {
  return `${runId}:${key}`;
}

type Taken =
  | { result: ActionResult; uncertain?: undefined }
  | { uncertain: ActionUncertain; result?: undefined }
  | undefined;

function titleOf(ctx: StepContext, options: ActionsPerformOptions): string {
  return `Confirm ${options.channel.name} send ${options.key} for run ${ctx.runId}`;
}

/**
 * The task for one uncertain action row. `DO NOTHING` on the partial unique index rather than an
 * upsert: whoever asked first owns the wording, and the id is looked up so the error can name it.
 *
 * The target columns follow the action row's, NULL included — a stand-in record type would fail
 * E002 at the next boot, and `origin_ref` is what points the task back at the row.
 */
async function openTask(
  db: StepDatabase,
  row: ActionRow,
  title: string,
): Promise<number | null> {
  const inserted = await db.execute<{ id: string }>(sql`
    INSERT INTO hf_task (record_type, record_id, title, origin, origin_ref)
    VALUES (${row.record_type}, ${row.record_id}, ${title}, 'flow', ${row.id})
    ON CONFLICT (origin, origin_ref) WHERE origin_ref IS NOT NULL DO NOTHING
    RETURNING id
  `);
  if (inserted.rows[0] !== undefined) return Number(inserted.rows[0].id);
  return existingTaskId(db, row.id);
}

/** Either writer may own it, so the lookup is not predicated on `origin`. */
async function existingTaskId(db: StepDatabase, actionLogId: string): Promise<number | null> {
  const found = await db.execute<{ id: string }>(sql`
    SELECT id FROM hf_task WHERE origin_ref = ${actionLogId} AND origin IN ('flow', 'sweep')
    ORDER BY id LIMIT 1
  `);
  const row = found.rows[0];
  return row === undefined ? null : Number(row.id);
}

/**
 * Whether the provider can still be trusted to dedupe this row's `idempotencyKey`. A declared
 * window that has run out makes `dedupes: true` worth nothing — the key means nothing to the
 * provider any more, so a re-send is a second delivery — and the row belongs on the `uncertain`
 * path with every other send nobody can account for.
 */
function withinDedupeWindow<Req>(channel: ActionChannel<Req>, row: ActionRow): boolean {
  const window = channel.dedupeWindowMs;
  if (window === undefined) return true;
  return Number(row.age_ms) <= window;
}

/** A row somebody else already moved to `uncertain`: report it, write nothing. */
async function uncertainOf(
  db: StepDatabase,
  ctx: StepContext,
  options: ActionsPerformOptions,
  row: ActionRow,
): Promise<ActionUncertain> {
  const taskId = await existingTaskId(db, row.id);
  return new ActionUncertain(ctx.runId, options.key, Number(row.id), taskId);
}

/**
 * One outbound side effect, ledgered on `hf_action_log` with the same `started`-row pattern as
 * `llm.run` and the same two-transaction shape — the lock order here is `hf_run` (via `ctx.tx`)
 * → `hf_action_log` → `hf_task`/`hf_activity`, which sit in the last tier.
 *
 * Re-entry of a row this attempt did not insert is where the channel's `dedupes` declaration is
 * spent, and only for as long as the channel's own `dedupeWindowMs` says the provider honours the
 * key. Inside it the row is simply re-taken and re-sent. Outside it — and on a channel that does
 * not dedupe at all — the row is never re-sent: it goes `uncertain`, a task asks a human whether
 * the first send went out, and `ActionUncertain` ends the run. A first dispatch always sends, so
 * neither case can produce more than one send per row without a human in it.
 */
export async function perform<Req>(
  ctx: StepContext,
  options: ActionsPerformOptions<Req>,
): Promise<ActionResult> {
  const taken = await ctx.tx<Taken>(async (db) => {
    const insert = await db.execute(sql`
      INSERT INTO hf_action_log
        (run_id, key, workflow_id, channel, idempotency_key, status, request, record_type, record_id)
      VALUES (${ctx.runId}, ${options.key}, ${ctx.workflowId}, ${options.channel.name},
              ${idempotencyKey(ctx.runId, options.key)}, 'started',
              ${JSON.stringify(options.request) ?? null}::jsonb,
              ${options.recordType ?? null}, ${options.recordId ?? null})
      ON CONFLICT (run_id, key) DO NOTHING
    `);
    const read = await db.execute<ActionRow>(sql`
      SELECT id::text AS id, status, external_id, response, record_type, record_id,
             (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::double precision AS age_ms
      FROM hf_action_log WHERE run_id = ${ctx.runId} AND key = ${options.key}
    `);
    const row = read.rows[0]!;
    if (row.status === "ok") {
      return { result: { externalId: row.external_id ?? undefined, response: row.response } };
    }
    // Already asked about, whatever the channel says: a second send behind the human's back is
    // the one thing the task exists to prevent.
    if (row.status === "uncertain") return { uncertain: await uncertainOf(db, ctx, options, row) };
    if (insert.rowCount !== 1) {
      if (options.channel.dedupes && withinDedupeWindow(options.channel, row)) {
        // `started_at` is deliberately not rewritten: the window is measured from the row's first
        // attempt, which is what the provider keyed its own dedupe on.
        await db.execute(sql`
          UPDATE hf_action_log
          SET status = 'started', workflow_id = ${ctx.workflowId}, finished_at = NULL
          WHERE run_id = ${ctx.runId} AND key = ${options.key}
        `);
        return undefined;
      }
      // `failed` joins `started` here: a channel that threw after delivering leaves exactly that,
      // so it is as unknown as a row nobody finished.
      const moved = await db.execute(sql`
        UPDATE hf_action_log SET status = 'uncertain', finished_at = now()
        WHERE run_id = ${ctx.runId} AND key = ${options.key}
          AND status IN ('started', 'failed')
      `);
      // The transition is the serialization point: a pass that moved the row first owns the task.
      if (moved.rowCount !== 1) return { uncertain: await uncertainOf(db, ctx, options, row) };

      const taskId = await openTask(db, row, titleOf(ctx, options));
      await db.execute(sql`
        INSERT INTO hf_activity (record_type, record_id, kind, run_id, meta)
        VALUES (${row.record_type}, ${row.record_id}, 'action.uncertain', ${ctx.runId},
                ${JSON.stringify({
                  actionLogId: Number(row.id),
                  key: options.key,
                  channel: options.channel.name,
                  taskId,
                })}::jsonb)
      `);
      return { uncertain: new ActionUncertain(ctx.runId, options.key, Number(row.id), taskId) };
    }
    return undefined;
  });
  // Outside the transaction: `ctx.tx` rolls back on anything thrown inside `work`, and the
  // `uncertain` row and its task are the whole point of this branch.
  if (taken?.uncertain !== undefined) throw taken.uncertain;
  if (taken?.result !== undefined) return taken.result;

  let result: ActionResult;
  try {
    result = await options.channel.send({
      idempotencyKey: idempotencyKey(ctx.runId, options.key),
      runId: ctx.runId,
      key: options.key,
      // `request` stays optional here, as it always was; a channel that declares a `Req` is
      // saying it will not be performed without one.
      request: options.request as Req,
    });
  } catch (error) {
    await ctx.tx(async (db) => {
      await db.execute(sql`
        UPDATE hf_action_log SET status = 'failed', finished_at = now()
        WHERE run_id = ${ctx.runId} AND key = ${options.key}
      `);
    });
    throw error;
  }

  await ctx.tx(async (db) => {
    await db.execute(sql`
      UPDATE hf_action_log
      SET status = 'ok', external_id = ${result.externalId ?? null},
          response = ${JSON.stringify(result.response) ?? null}::jsonb, finished_at = now()
      WHERE run_id = ${ctx.runId} AND key = ${options.key}
    `);
  });
  return result;
}

export const actions = { perform };

/** The only channel chunk 10 ships: it dispatches nothing and succeeds. */
export function stubChannel(name = "stub"): ActionChannel {
  return {
    name,
    dedupes: true,
    send: (dispatch) =>
      Promise.resolve({ externalId: dispatch.idempotencyKey, response: { stub: true } }),
  };
}
