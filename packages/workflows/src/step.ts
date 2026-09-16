import { DBOS } from "@dbos-inc/dbos-sdk";
import { StaleAttempt, type StepDatabase } from "@hyperfixation/db";
import { currentRun } from "./run-context.js";
import { concludeRun } from "./run-status.js";
import { Suspend } from "./suspend.js";
import { workerRuntime } from "./worker-runtime.js";

/** The only database handle a step body is given. */
export interface StepContext {
  readonly runId: string;
  readonly attempt: number;
  readonly workflowId: string;
  /** The step's own key: what a ledger row or an action log is keyed by. */
  readonly key: string;
  tx<T>(work: (db: StepDatabase) => Promise<T>): Promise<T>;
}

export interface StepOptions {
  /** Distinguishes two calls of the same `name`, as a loop over records does. */
  key?: string;
}

/** The pause gate and the fencing token, read together so one round trip answers both. */
export const STEP_GATE_STATEMENT =
  "SELECT COALESCE((SELECT paused FROM hf_app_state WHERE id = 1), false) AS paused, " +
  "(SELECT current_workflow_id FROM hf_run WHERE run_id = $1) AS current_workflow_id";

interface StepGate {
  paused: boolean;
  currentWorkflowId: string | null;
}

/**
 * A checkpointed function, preceded by a checkpointed read of the pause flag and the run's
 * fencing token.
 *
 * The gate is a step that returns the *reading* and throws nothing. Were the throw inside it,
 * DBOS would checkpoint the error through `serialize-error` and a replay would revive a plain
 * `Error`, so `defineFlow`'s `instanceof Suspend` would stop catching it after a recovery.
 *
 * Retries are off because a step body here is a database write or a billable provider call:
 * "at least once" is the guarantee the ledger and the `ctx.tx` fence are built to survive,
 * and a silent in-process retry would add attempts neither of them can see.
 */
export async function step<T>(
  name: string,
  fn: (ctx: StepContext) => Promise<T>,
  options: StepOptions = {},
): Promise<T> {
  const run = currentRun(`step(${name})`);
  const runtime = workerRuntime(`step(${name})`);
  const key = options.key ?? name;

  const gate = await DBOS.runStep(() => readGate(runtime, run.runId), {
    name: `${name}:gate`,
    retriesAllowed: false,
  });

  if (gate.paused) {
    await concludeRun(runtime.control.pool, run.runId, run.workflowId, "paused", null);
    throw new Suspend(run.runId, "paused", `the app is paused, before step ${key}`);
  }
  if (gate.currentWorkflowId !== run.workflowId) {
    throw new StaleAttempt(run.runId, run.workflowId);
  }

  const context: StepContext = {
    runId: run.runId,
    attempt: run.attempt,
    workflowId: run.workflowId,
    key,
    tx: (work) => runtime.steps.tx(run.runId, run.workflowId, work),
  };

  return await DBOS.runStep(() => fn(context), {
    name: key === name ? name : `${name}:${key}`,
    retriesAllowed: false,
  });
}

/** A plain read, so the step pool passes it without a tag. */
async function readGate(
  runtime: ReturnType<typeof workerRuntime>,
  runId: string,
): Promise<StepGate> {
  const { rows } = await runtime.steps.pool.query<{
    paused: boolean;
    current_workflow_id: string | null;
  }>(STEP_GATE_STATEMENT, [runId]);
  const row = rows[0]!;
  return { paused: row.paused, currentWorkflowId: row.current_workflow_id };
}
