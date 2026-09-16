import { parkedMarker, type KillAtControl, type KillAtMode } from "./worker-protocol.js";
import type { SpawnedWorker, WorkerExit } from "./spawn-worker.js";

/**
 * Arranges for a named step in a spawned worker to stop at one of three points relative to
 * its DBOS checkpoint. Pass the result as the worker's `killAt` control; the flow module's
 * `parkFor()` calls are what honour it.
 */
export function killAt(stepKey: string, mode: KillAtMode): KillAtControl {
  return { key: stepKey, mode };
}

/**
 * Waits until the worker is demonstrably parked at `at`, then `SIGKILL`s it. Because the
 * worker parks rather than racing on, "killed before the checkpoint" and "killed after it"
 * are arranged facts here, not timing luck.
 */
export async function killWhenParked(
  worker: SpawnedWorker,
  at: KillAtControl,
  timeoutMs?: number,
): Promise<WorkerExit> {
  await worker.waitFor(parkedMarker(at), timeoutMs);
  return worker.kill();
}
