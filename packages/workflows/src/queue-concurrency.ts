import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { QUEUES, type QueueName } from "./start-worker.js";

/**
 * The queues `pause` stops. `resolve` is deliberately not one of them: the plan names `llm` and
 * `actions`, the two that spend money and reach the outside world, and a resolution batch is
 * stopped by the step gate at its next step like everything else.
 */
export const PAUSED_QUEUES = ["llm", "actions"] as const satisfies readonly QueueName[];

export interface QueueConcurrency {
  name: QueueName;
  globalConcurrency: number;
  /**
   * False when no `dbos.queues` row exists yet — no worker has launched — so the concurrency
   * could not be written. The pause itself still stands: `hf_app_state.paused` is what a step
   * reads, and `startWorker()` re-applies the zero on the way up.
   */
  applied: boolean;
}

/** What `pause` sets the two queues to. Zero means the dequeue claims nothing at all. */
export const PAUSED_CONCURRENCY = 0;

/** What a resume — and `reconcile()`'s step (6) — puts a queue back to. */
export function registeredConcurrency(name: QueueName): number {
  return QUEUES.find((queue) => queue.name === name)!.globalConcurrency;
}

/**
 * Sets `llm` and `actions` to zero, or back to their registered concurrency. The queues are
 * database-backed (`DBOS.registerQueue` persists them), so a worker in another process picks
 * the change up on its next reconcile of the queues table — this is callable from the web.
 *
 * It is the *second* half of a pause and the *first* half of a resume in both cases: the
 * correctness mechanism is the pause flag the step gate reads, and this only stops work from
 * being dispatched that the gate would immediately suspend.
 */
export async function setPausedQueueConcurrency(
  client: DBOSClient,
  paused: boolean,
): Promise<QueueConcurrency[]> {
  const applied: QueueConcurrency[] = [];
  for (const name of PAUSED_QUEUES) {
    const globalConcurrency = paused ? PAUSED_CONCURRENCY : registeredConcurrency(name);
    const queue = await client.retrieveQueue(name);
    if (queue === null) {
      applied.push({ name, globalConcurrency, applied: false });
      continue;
    }
    await queue.setGlobalConcurrency(globalConcurrency);
    applied.push({ name, globalConcurrency, applied: true });
  }
  return applied;
}
