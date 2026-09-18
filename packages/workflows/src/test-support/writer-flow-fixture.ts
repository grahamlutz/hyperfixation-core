/** The child half: registers `writerFlow` (imported for its side effect) and runs a worker. */
import { setTimeout as delay } from "node:timers/promises";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { runWorkerModule } from "@hyperfixation/testing/worker";
import { startWorker, type StartWorkerOptions, type Worker } from "../start-worker.js";
import { WorkerLockUnavailable } from "../worker-lock.js";
import { SHUTDOWN_RETURNED_MARKER, type WriterFlowControl } from "./writer-flow.js";
import "./writer-flow.js";

/** How long worker B waits for the lock A holds until its process dies. */
const LOCK_POLL_TIMEOUT_MS = 90_000;

await runWorkerModule<WriterFlowControl>({
  start: ({ appName, databaseUrl, control }) => {
    markShutdownReturn();
    return startWhenLockIsFree({ appName, databaseUrl }, control.lockPollMs);
  },
});

/**
 * Wrapped here rather than in the harness, and inside `start` so this wrapper sits *outside*
 * `drainMs`: what case 7 times is the whole drain returning, which is the last instant before
 * the process — and with it the advisory lock — can go away.
 */
function markShutdownReturn(): void {
  const shutdown = DBOS.shutdown.bind(DBOS);
  DBOS.shutdown = (options) =>
    shutdown(options).then(() => {
      console.info(SHUTDOWN_RETURNED_MARKER);
    });
}

async function startWhenLockIsFree(
  options: StartWorkerOptions,
  pollMs: number | undefined,
): Promise<Worker> {
  if (pollMs === undefined) return startWorker(options);

  const deadline = Date.now() + LOCK_POLL_TIMEOUT_MS;
  for (;;) {
    try {
      return await startWorker(options);
    } catch (error) {
      if (!(error instanceof WorkerLockUnavailable) || Date.now() > deadline) throw error;
      await delay(pollMs);
    }
  }
}
