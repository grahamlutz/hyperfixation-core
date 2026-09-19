import type { StepPool } from "@hyperfixation/db";
import type { ApprovalNotifier } from "./approvals.js";
import type { ControlPool } from "./control-pool.js";

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
 */
let current: WorkerRuntime | undefined;

export function setWorkerRuntime(runtime: WorkerRuntime): void {
  current = runtime;
}

export function workerRuntime(operation: string): WorkerRuntime {
  if (current === undefined) throw new WorkerNotStarted(operation);
  return current;
}
