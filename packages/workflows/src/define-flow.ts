import { DBOS } from "@dbos-inc/dbos-sdk";
import { OutsideRun, withRunContext, type RunContext } from "./run-context.js";
import { claimRun, concludeRun } from "./run-status.js";
import { QUEUES, type QueueName } from "./start-worker.js";
import { Suspend } from "./suspend.js";
import { workerRuntime } from "./worker-runtime.js";

/** What DBOS carries as the workflow's one argument. */
export interface FlowArgs<I> {
  runId: string;
  attempt: number;
  input: I;
}

export interface Flow<I = unknown, O = unknown> {
  readonly name: string;
  readonly queue: QueueName;
  /** The registered DBOS workflow. `runs.start` enqueues it by name, never by reference. */
  readonly workflow: (args: FlowArgs<I>) => Promise<O | undefined>;
}

export interface DefineFlowOptions {
  queue: QueueName;
}

export class DuplicateFlow extends Error {
  constructor(name: string) {
    super(`DuplicateFlow: a flow named ${JSON.stringify(name)} is already defined`);
    this.name = "DuplicateFlow";
  }
}

export class UnknownQueue extends Error {
  constructor(name: string, queue: string) {
    super(
      `UnknownQueue: flow ${JSON.stringify(name)} names queue ${JSON.stringify(queue)}; ` +
        `the queues are ${QUEUES.map((q) => q.name).join(", ")}`,
    );
    this.name = "UnknownQueue";
  }
}

/** Logged when an attempt finds the run already on a later one; it runs nothing. */
export const SUPERSEDED_MARKER = "hf-run: superseded attempt, the flow was not run";

const flows = new Map<string, Flow<never, unknown>>();

/** The one source of a queue name for an enqueue, and of a flow name for `runs.start`. */
export function definedFlows(): ReadonlyMap<string, Flow<never, unknown>> {
  return flows;
}

/**
 * Registers `fn` as a DBOS workflow whose lifecycle is the run's. The wrapper owns every
 * `hf_run` status write of the attempt, and every one of them carries the
 * `AND current_workflow_id = …` fence — the wrapper's job is as much to *not* write after a
 * bump as it is to write.
 */
export function defineFlow<I, O>(
  name: string,
  fn: (input: I, run: RunContext) => Promise<O>,
  options: DefineFlowOptions,
): Flow<I, O> {
  if (flows.has(name)) throw new DuplicateFlow(name);
  if (!QUEUES.some((queue) => queue.name === options.queue)) {
    throw new UnknownQueue(name, options.queue);
  }

  const workflow = DBOS.registerWorkflow(
    async (args: FlowArgs<I>): Promise<O | undefined> => {
      const workflowId = DBOS.workflowID;
      if (workflowId === undefined) throw new OutsideRun(`flow ${name}`);
      const runtime = workerRuntime(`flow ${name}`);
      const run: RunContext = { runId: args.runId, attempt: args.attempt, workflowId };

      // The claim is the fence as well as the status write: zero rows means a bump moved the
      // run on before this attempt was dequeued, so it stops here without touching the run.
      // Not an error — a superseded attempt ending quietly is the design working.
      if (!(await claimRun(runtime.control.pool, run.runId, workflowId, runtime.applicationVersion))) {
        console.info(SUPERSEDED_MARKER, JSON.stringify({ flow: name, ...run }));
        return undefined;
      }

      try {
        const output = await withRunContext(run, () => fn(args.input, run));
        await concludeRun(runtime.control.pool, run.runId, workflowId, "done", null);
        return output;
      } catch (error) {
        if (error instanceof Suspend) {
          await concludeRun(runtime.control.pool, run.runId, workflowId, error.status, null);
          return undefined;
        }
        await concludeRun(runtime.control.pool, run.runId, workflowId, "failed", messageOf(error));
        throw error;
      }
    },
    { name },
  );

  const flow: Flow<I, O> = { name, queue: options.queue, workflow };
  flows.set(name, flow as unknown as Flow<never, unknown>);
  return flow;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
