import { DBOS } from "@dbos-inc/dbos-sdk";
import { flowFingerprint } from "./flow-fingerprint.js";
import { OutsideRun, withRunContext, type RunContext } from "./run-context.js";
import { claimRun, concludeRun } from "./run-status.js";
import { QUEUES, WORKER_PROCESS, type QueueName } from "./start-worker.js";
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
  /**
   * The registered DBOS workflow in a worker, and the bare body anywhere else — see
   * `defineFlow`. Either way nothing calls it: `runs.start` enqueues by name, never by
   * reference, and calling it outside a run throws `OutsideRun`.
   */
  readonly workflow: (args: FlowArgs<I>) => Promise<O | undefined>;
}

export interface DefineFlowOptions {
  queue: QueueName;
  /**
   * Which definition of this name this is, for the rare case where the bundler defeats
   * `flowFingerprint`'s reading of the body — see its comment for the two shapes that do. Set it
   * and the body is not compared at all: every copy of this definition matches, and a different
   * definition of the same name must carry a different `version` to be told apart from it.
   */
  version?: string;
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

/** Per name, what `flowFingerprint` made of the definition that got in first. */
const fingerprints = new Map<string, string>();

/** The one source of a queue name for an enqueue, and of a flow name for `runs.start`. */
export function definedFlows(): ReadonlyMap<string, Flow<never, unknown>> {
  return flows;
}

/**
 * Registers `fn` as a DBOS workflow whose lifecycle is the run's. The wrapper owns every
 * `hf_run` status write of the attempt, and every one of them carries the
 * `AND current_workflow_id = …` fence — the wrapper's job is as much to *not* write after a
 * bump as it is to write.
 *
 * The DBOS registration itself happens only in a worker process; see the comment on it.
 */
export function defineFlow<I, O>(
  name: string,
  fn: (input: I, run: RunContext) => Promise<O>,
  options: DefineFlowOptions,
): Flow<I, O> {
  // A second call with the *same* definition is one definition reaching here twice, not two
  // flows fighting over a name: Next instantiates the app's `src/flows/*.ts` once per module
  // layer — the rsc page layer and the server-action layer of one authenticated request — while
  // this package stays external and singular, so the registry sees both. That is the first
  // instance's flow, already registered with DBOS if this is a worker; hand it back rather than
  // registering it again. Two different definitions of one name are still a collision.
  //
  // "The same definition" is `flowFingerprint`'s reading of it, and not the same source text: each
  // layer is minified with its own name budget, so the two copies never match character for
  // character. See that function for what the comparison keeps and what it cannot see.
  const existing = flows.get(name);
  if (existing !== undefined) {
    if (fingerprints.get(name) !== flowFingerprint(fn, options)) throw new DuplicateFlow(name);
    return existing as unknown as Flow<I, O>;
  }
  if (!QUEUES.some((queue) => queue.name === options.queue)) {
    throw new UnknownQueue(name, options.queue);
  }

  const body = async (args: FlowArgs<I>): Promise<O | undefined> => {
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
  };

  // Only in the worker, and for the same reason `DBOS.launch()` is only there: a registration
  // is a global side effect in the one object DBOS keeps per process, and the web's copy of
  // this module is not one per process. Next splits an app's server code per route, so
  // `src/flows/*.ts` is evaluated once per chunk that reaches it while `@dbos-inc/dbos-sdk`
  // stays external and singular — the second evaluation is refused and every route that
  // touches the app 500s from then on. The web never dispatches a workflow anyway; it enqueues
  // by name through `DBOSClient`, and the name comes from `flows` below, which is per-instance
  // and identical in every instance.
  const workflow =
    process.env.HF_PROCESS === WORKER_PROCESS ? DBOS.registerWorkflow(body, { name }) : body;

  const flow: Flow<I, O> = { name, queue: options.queue, workflow };
  flows.set(name, flow as unknown as Flow<never, unknown>);
  fingerprints.set(name, flowFingerprint(fn, options));
  return flow;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
