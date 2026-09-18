import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { AppStateMissing, controlPlaneTx, SET_APP_PAUSED_STATEMENT } from "@hyperfixation/db";
import {
  reconcile,
  setPausedQueueConcurrency,
  type QueueConcurrency,
  type ReconcileReport,
} from "@hyperfixation/workflows";
import type { Pool } from "pg";

export const PAUSE_OPERATION = "app.pause";
export const RESUME_OPERATION = "app.resume";

/** One line per transition, carrying who asked for it. */
export const PAUSED_MARKER = "hf-app: paused";
export const RESUMED_MARKER = "hf-app: resumed";

const AUDIT_STATEMENT =
  "INSERT INTO hf_audit (actor_id, action, target_type, target_id, meta) " +
  "VALUES ($1, $2, 'hf_app_state', '1', $3::jsonb)";

export interface PauseOptions {
  /** Recorded in `hf_app_state.paused_by` and on the audit row. */
  userId?: string | null;
  reason?: string;
}

export interface PauseResult {
  paused: true;
  queues: QueueConcurrency[];
}

export interface ResumeOptions extends PauseOptions {
  /** What `reconcile()` treats as the live version; `defineApp` supplies the app's. */
  applicationVersion: string;
}

export interface ResumeResult {
  paused: false;
  queues: QueueConcurrency[];
  /** The pass that started the next attempt of every run the pause parked. */
  reconciled: ReconcileReport;
}

/**
 * A control-plane operation. The flag goes first and the queues second, in that order for a
 * reason: `hf_app_state.paused` is what the step gate reads, so it is the whole of the
 * correctness, and zero concurrency only stops work being dispatched that the gate would
 * suspend at its first step anyway. A pause whose queue half failed is still a pause.
 */
export async function pauseApp(
  pool: Pool,
  client: DBOSClient,
  options: PauseOptions = {},
): Promise<PauseResult> {
  await setPaused(pool, PAUSE_OPERATION, true, options);
  const queues = await setPausedQueueConcurrency(client, true);
  console.info(PAUSED_MARKER, JSON.stringify({ by: options.userId ?? null, queues }));
  return { paused: true, queues };
}

/**
 * The mirror, in the mirrored order: the queues are restored only once the flag is clear, so
 * there is no window in which a step is dispatched into an app that still reads as paused and
 * suspends it again. `reconcile()` last, because step (3) is what starts the next attempt of
 * every run the pause parked, and it only moves a `paused` run while the app is not paused.
 */
export async function resumeApp(
  pool: Pool,
  client: DBOSClient,
  options: ResumeOptions,
): Promise<ResumeResult> {
  await setPaused(pool, RESUME_OPERATION, false, options);
  const queues = await setPausedQueueConcurrency(client, false);
  console.info(RESUMED_MARKER, JSON.stringify({ by: options.userId ?? null, queues }));

  const reconciled = await reconcile(pool, client, {
    applicationVersion: options.applicationVersion,
  });
  return { paused: false, queues, reconciled };
}

/** The flag and its audit row in one tag-asserted transaction; the audit insert is fatal. */
async function setPaused(
  pool: Pool,
  operation: string,
  paused: boolean,
  options: PauseOptions,
): Promise<void> {
  await controlPlaneTx(pool, { operation }, async (client) => {
    const written = await client.query(SET_APP_PAUSED_STATEMENT, [
      paused,
      paused ? (options.userId ?? null) : null,
    ]);
    if (written.rowCount !== 1) throw new AppStateMissing(operation);

    await client.query(AUDIT_STATEMENT, [
      options.userId ?? null,
      paused ? "app.paused" : "app.resumed",
      JSON.stringify({ reason: options.reason ?? null }),
    ]);
  });
}
