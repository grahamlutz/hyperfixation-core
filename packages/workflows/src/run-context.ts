import { AsyncLocalStorage } from "node:async_hooks";
import { processGlobal } from "./process-global.js";

export interface RunContext {
  runId: string;
  attempt: number;
  /** `DBOS.workflowID` of the attempt in flight; the fencing token every write matches. */
  workflowId: string;
}

export class OutsideRun extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(`OutsideRun: ${operation} can only be called from inside a flow body`);
    this.name = "OutsideRun";
    this.operation = operation;
  }
}

/**
 * How `step()` reaches the run it belongs to. `ctx.tx(runId, workflowId, …)` takes both
 * explicitly — that seam is what lets `fence.test.ts` run with no DBOS launch — so something
 * has to carry them from the workflow to the step, and DBOS's own arguments only reach the
 * flow body. App code never passes them, so it cannot pass the wrong ones.
 *
 * Process-global rather than module-level: two copies of this module would be two storages, and
 * a `step()` reached through the second would see no context and throw `OutsideRun` inside a
 * perfectly ordinary run.
 */
const storage = processGlobal(
  "@hyperfixation/workflows#runContext",
  () => new AsyncLocalStorage<RunContext>(),
);

export function withRunContext<T>(context: RunContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export function currentRun(operation: string): RunContext {
  const context = storage.getStore();
  if (context === undefined) throw new OutsideRun(operation);
  return context;
}
