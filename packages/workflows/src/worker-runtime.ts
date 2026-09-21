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
 *
 * The one key of the three that carries a shape version. `WorkerRuntime` is a structural record
 * this package reads field by field, so two *versions* of the package sharing this slot would
 * hand `workerRuntime()` a shape it does not know — a wrong answer, not an error. The
 * `AsyncLocalStorage` and the control-plane map stay unversioned on purpose: sharing those across
 * versions is the point of putting them here at all. Nothing is lost by refusing here, because
 * the advisory lock already allows one worker per process: the second version's flows have no
 * worker of their own to find, and `WorkerNotStarted` says so.
 */
const holder = processGlobal<{ current?: WorkerRuntime }>(
  "@hyperfixation/workflows#workerRuntime.v1",
  () => ({}),
);

export function setWorkerRuntime(runtime: WorkerRuntime): void {
  holder.current = runtime;
}

/**
 * Test-only, and deliberately not exported from `index.ts`: the runtime is the worker's for the
 * life of the process, and nothing in an app has a reason to unset it. A test needs it because
 * the slot is the realm's — a `setWorkerRuntime()` a case never undid is one the next case, and
 * the next file in the same vitest worker, would read as a started worker.
 */
export function clearWorkerRuntime(): void {
  delete holder.current;
}

export function workerRuntime(operation: string): WorkerRuntime {
  if (holder.current === undefined) throw new WorkerNotStarted(operation);
  return holder.current;
}
