/**
 * The lines and environment variables a spawned worker and the harness driving it agree on.
 * Kept in a module of its own so neither side pulls the other's machinery in: `./worker` must
 * not load `node:child_process`, and a test must not load the child's `DBOS.shutdown` patch.
 */

/** Printed once the module's `start` resolved; `spawnWorker().ready()` waits for it. */
export const WORKER_READY = "hf-worker-fixture: ready";

/** `<marker> <name>: <message>` for any refusal that is not a fencing one. */
export const WORKER_FAILED = "hf-worker-fixture: failed";

/**
 * `<marker> <json of FencingFailure>`. Distinct from `WORKER_FAILED` because an
 * `UnfencedWrite` or a `ControlPlaneInWorkflow` is a bug in the code under test rather than
 * the crash a redeploy case is arranging, and must never read as one.
 */
export const WORKER_FENCING_FAILURE = "hf-worker-fixture: fencing-failure";

/** Written to the worker's stdin to ask for a clean shutdown and exit 0. */
export const WORKER_SHUTDOWN = "shutdown";

export const WORKER_APP_NAME_ENV = "HF_APP_NAME";
export const WORKER_DATABASE_URL_ENV = "HF_DATABASE_URL";
export const WORKER_CONTROL_ENV = "HF_WORKER_CONTROL";

/**
 * Behaviour knobs a test sets on the worker it spawns, carried as JSON in one environment
 * variable so a module declares what it reads instead of the caller knowing env var names.
 */
export interface WorkerControl {
  /**
   * Holds the drain open this long before the real `DBOS.shutdown()` is entered — what a
   * worker with in-flight work does, which chunk 9's flows do not yet exist to provide.
   */
  drainMs?: number;
  [knob: string]: unknown;
}
