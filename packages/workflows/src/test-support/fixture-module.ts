/**
 * What the worker fixture and the tests driving it agree on, beyond the protocol
 * `@hyperfixation/testing` owns. Kept in a module of its own so importing a marker does not
 * run the fixture.
 */
import { fileURLToPath } from "node:url";
import type { WorkerControl } from "@hyperfixation/testing";

/** The plain-worker module every redeploy test spawns: a real process calling `startWorker()`. */
export const WORKER_FIXTURE_MODULE = fileURLToPath(
  new URL("./worker-fixture.ts", import.meta.url),
);

/** Printed once Sentry's `unhandledRejection` listener and the rejecting `shutdown` are in. */
export const SENTRY_ARMED_MARKER = "hf-fixture: rejecting shutdown armed behind Sentry";

export interface FixtureControl extends WorkerControl {
  /**
   * Makes the fixture's `DBOS.shutdown()` reject after this many ms behind Sentry's
   * `unhandledRejection` listener — redeploy case 11's second half.
   */
  rejectShutdownAfterMs?: number;
}
