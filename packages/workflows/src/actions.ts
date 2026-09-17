import { sql } from "drizzle-orm";
import type { StepContext } from "./step.js";

/** What a channel is handed. `idempotencyKey` is stable across attempts, so a provider that
 * supports one dedupes a re-send rather than sending twice. */
export interface ActionDispatch {
  idempotencyKey: string;
  runId: string;
  key: string;
  request: unknown;
}

export interface ActionResult {
  externalId?: string;
  response?: unknown;
}

export interface ActionChannel {
  readonly name: string;
  send(dispatch: ActionDispatch): Promise<ActionResult>;
}

export interface ActionsPerformOptions {
  /** Unique within the run and stable across attempts, exactly as `llm.run`'s is. */
  key: string;
  channel: ActionChannel;
  request?: unknown;
  recordType?: string;
  recordId?: string;
}

interface ActionRow extends Record<string, unknown> {
  status: string;
  external_id: string | null;
  response: unknown;
}

export function idempotencyKey(runId: string, key: string): string {
  return `${runId}:${key}`;
}

/**
 * One outbound side effect, ledgered on `hf_action_log` with the same `started`-row pattern as
 * `llm.run` and the same two-transaction shape — the lock order here is `hf_run` (via `ctx.tx`)
 * → `hf_action_log`, with no budget row in between.
 *
 * Minimum slice: no `ActionUncertain` and no task creation, which need `hf_task` (Phase 2). A
 * channel that cannot dedupe therefore still re-sends here rather than asking a human.
 */
export async function perform(
  ctx: StepContext,
  options: ActionsPerformOptions,
): Promise<ActionResult> {
  const dispatched = await ctx.tx(async (db) => {
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
      SELECT status, external_id, response FROM hf_action_log
      WHERE run_id = ${ctx.runId} AND key = ${options.key}
    `);
    const row = read.rows[0]!;
    if (row.status === "ok") {
      return { externalId: row.external_id ?? undefined, response: row.response };
    }
    if (insert.rowCount !== 1) {
      await db.execute(sql`
        UPDATE hf_action_log
        SET status = 'started', workflow_id = ${ctx.workflowId}, finished_at = NULL
        WHERE run_id = ${ctx.runId} AND key = ${options.key}
      `);
    }
    return undefined;
  });
  if (dispatched !== undefined) return dispatched;

  let result: ActionResult;
  try {
    result = await options.channel.send({
      idempotencyKey: idempotencyKey(ctx.runId, options.key),
      runId: ctx.runId,
      key: options.key,
      request: options.request,
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
    send: (dispatch) =>
      Promise.resolve({ externalId: dispatch.idempotencyKey, response: { stub: true } }),
  };
}
