import type { StepPool } from "@hyperfixation/db";
import type { ApprovalNotifier } from "./approvals.js";
import type { ControlPool } from "./control-pool.js";
import { processGlobal } from "./process-global.js";

/** What a running flow needs from the worker that launched it. */
export interface WorkerRuntime {
  appName: string;
  applicationVersion: string;
  steps: StepPool;
  control: ControlPool;
  /** What `waitForApproval` notifies through when the call passes no `notify` of its own. */
  approvalNotifier?: ApprovalNotifier;
}

export class WorkerNotStarted extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`WorkerNotStarted: ${operation} needs the pools startWorker() builds`);
    this.name = "WorkerNotStarted";
    this.operation = operation;
  }
}

/**
 * Process-wide because `DBOS.launch()` is: one worker per process is already enforced by the
 * advisory lock, and a flow function reached by DBOS recovery is handed nothing but its own
 * arguments — there is no call site to thread the pools through.
 *
 * On the process global for the same reason the run context is: a flow body reads both on
 * adjacent lines, and a second copy of this module holding its own `undefined` would answer
 * `WorkerNotStarted` for a worker that started.
 */
const holder = processGlobal<{ current?: WorkerRuntime }>(
  "@hyperfixation/workflows#workerRuntime",
  () => ({}),
);

export function setWorkerRuntime(runtime: WorkerRuntime): void {
  holder.current = runtime;
}

export function workerRuntime(operation: string): WorkerRuntime {
  if (holder.current === undefined) throw new WorkerNotStarted(operation);
  return holder.current;
}
