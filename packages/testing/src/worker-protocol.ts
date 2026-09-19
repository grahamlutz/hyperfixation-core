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

/** Written to the worker's stdin to let every parked `parkFor()` go. */
export const WORKER_RELEASE = "release";

/** `clock <iso>` on the worker's stdin re-pins `workerClock()`, live, with no restart. */
export const WORKER_CLOCK = "clock";

/**
 * Where a step is held relative to its DBOS checkpoint. The checkpoint is written after the
 * step body returns and before `runStep` resolves (`dbos-executor.js:768-780`), which is what
 * makes the first two more than a race: `'before-checkpoint'` parks *inside* the body, so
 * `runStep` never resolves and no row can exist; `'after-checkpoint'` parks in the flow body
 * after `runStep` resolved, so the row is already durable.
 */
export type KillAtMode = "before-checkpoint" | "after-checkpoint" | "in-tx";

/** The step a worker is to park at, and where relative to its checkpoint. */
export interface KillAtControl {
  /** The `key` of the `step()` call, not its name. */
  key: string;
  mode: KillAtMode;
}

/** `<marker> <mode> <key>`, printed the instant the worker reaches the arranged point. */
export const WORKER_PARKED = "hf-worker-fixture: parked at";

export function parkedMarker(at: KillAtControl): string {
  return `${WORKER_PARKED} ${at.mode} ${at.key}`;
}

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
  /** Where the worker parks, for `killWhenParked()` to kill it or `release()` to let it go. */
  killAt?: KillAtControl;
  /**
   * An ISO timestamp `workerClock()` is pinned to from the worker's first read. Pinned rather
   * than an offset: a spawned worker takes seconds to reach ready, and an offset would carry
   * that delay into whatever instant the case is arranging.
   */
  clockAt?: string;
  [knob: string]: unknown;
}
