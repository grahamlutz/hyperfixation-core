import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { bumpAttempt, controlPlaneTx } from "@hyperfixation/db";
import type { Pool } from "pg";
import { FencingFailureInTest } from "./fencing.js";
import { assertNoFencingFailure, type SpawnedWorker } from "./spawn-worker.js";

/**
 * Runs a flow to a conclusion, then **restarts** it through the one attempt-bump path and
 * asserts the second attempt added nothing.
 *
 * The restart is the point. A run crosses a deploy only by restarting — `reconcile()` bumps
 * every run left `running` under the old version through exactly this path — so a flow that is
 * not idempotent across an attempt bump is a flow that double-charges, double-sends or
 * double-writes on the first redeploy that happens to catch it mid-run. That is invisible in a
 * test that runs a flow once.
 *
 * "Zero new provider calls" is a row count here, not a spy: the cassette lives in the worker
 * process, so what is countable from this side is `hf_llm_call` plus the rows it flagged as a
 * possible double charge.
 *
 * Every handle comes from the caller because provisioning one needs `@hyperfixation/workflows`,
 * which this package cannot import — its tests depend on this harness, so the dependency only
 * runs the other way.
 */

/** Enough of a `Flow` to bump and enqueue one; `Flow<I, O>` satisfies it structurally. */
export interface FlowRef {
  readonly name: string;
  readonly queue: string;
}

/** What starting a run answers with: `runsStart`'s return, structurally. */
export interface StartedRunRef {
  runId: string;
  workflowId: string;
}

export interface FlowSyncHarness {
  /** A control-plane handle on the application role: the bump, the enqueue and the counts. */
  pool: Pool;
  /** The web's client, for `enqueueInTransaction` inside the bump's transaction. */
  client: DBOSClient;
  /** The process running the flows, for its fencing-refusal markers. */
  worker: SpawnedWorker;
  /** `runsStart(pool, client, flow, input)`, which only the caller can call. */
  start(flow: FlowRef, input: unknown): Promise<StartedRunRef>;
  /** App tables counted alongside `RESTART_COUNTED_TABLES`. */
  tables?: readonly string[];
}

export interface RunFlowSyncOptions {
  /**
   * Skips the second attempt, with the reason mandatory by type — the assertion being opted
   * out of is the one that catches double-charges.
   */
  restart?: { skip: string };
  /** Per attempt, not for the pair. */
  timeoutMs?: number;
}

/** Where a flow can legitimately stop: `failed` is not one of them. */
export type SettledRunStatus = "done" | "waiting" | "paused";

export interface FlowSyncResult {
  runId: string;
  /** Both attempts settle here; a `waiting` flow must re-suspend rather than finish. */
  status: SettledRunStatus;
  attempts: 1 | 2;
  /** One per attempt, in order. */
  workflowIds: string[];
  counts: Record<string, number>;
}

/** Every machinery table whose row count a restart must not change. */
export const RESTART_COUNTED_TABLES = [
  "hf_llm_call",
  "hf_action_log",
  "hf_activity",
  "hf_task",
  "hf_audit",
  "hf_approval",
] as const;

/** The one counted thing that is not a table: rows the ledger flagged as billed twice. */
export const DOUBLE_CHARGE_COUNT_KEY = "hf_llm_call.possible_double_charge";

export const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;

/** Printed instead of running the second attempt, so a skip is visible in the test's output. */
export const RESTART_SKIPPED_MARKER = "runFlowSync: restart skipped —";

const OPERATION = "runFlowSync";

export class RestartChangedCounts extends Error {
  readonly runId: string;
  /** Only what changed. */
  readonly diff: Record<string, { before: number; after: number }>;

  constructor(runId: string, diff: Record<string, { before: number; after: number }>) {
    super(
      `RestartChangedCounts: run ${runId}'s second attempt changed ` +
        `${Object.keys(diff).length} count(s):\n` +
        Object.entries(diff)
          .map(([name, { before, after }]) => `  ${name}: ${before} -> ${after}`)
          .join("\n"),
    );
    this.name = "RestartChangedCounts";
    this.runId = runId;
    this.diff = diff;
  }
}

export async function runFlowSync(
  harness: FlowSyncHarness,
  flow: FlowRef,
  input: unknown,
  options: RunFlowSyncOptions = {},
): Promise<FlowSyncResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const started = await harness.start(flow, input);
  const first = await settle(harness, started.runId, started.workflowId, 1, timeoutMs);

  if (options.restart !== undefined) {
    console.info(RESTART_SKIPPED_MARKER, options.restart.skip);
    return {
      runId: started.runId,
      status: first,
      attempts: 1,
      workflowIds: [started.workflowId],
      counts: await snapshotCounts(harness),
    };
  }

  const before = await snapshotCounts(harness);

  // Exactly what `reconcile()` and `decide()` do to a run a redeploy interrupted: one
  // transaction that takes `hf_run FOR UPDATE`, moves the fencing token on and enqueues the
  // next attempt. Nothing about the flow knows it is the second time.
  const bumped = await controlPlaneTx(harness.pool, { operation: OPERATION }, async (pg) => {
    const next = await bumpAttempt(pg, started.runId);
    await harness.client.enqueueInTransaction(
      pg,
      { queueName: flow.queue, workflowName: flow.name, workflowID: next.workflowId },
      { runId: started.runId, attempt: next.attempt, input: next.input },
    );
    return next;
  });

  const second = await settle(harness, started.runId, bumped.workflowId, bumped.attempt, timeoutMs);
  if (second !== first) {
    throw new Error(
      `runFlowSync: run ${started.runId} settled ${first} on attempt 1 and ${second} on ` +
        `attempt ${bumped.attempt}; a restarted flow must reach the same place`,
    );
  }

  const after = await snapshotCounts(harness);
  const diff: Record<string, { before: number; after: number }> = {};
  for (const [name, count] of Object.entries(after)) {
    if (before[name] !== count) diff[name] = { before: before[name] ?? 0, after: count };
  }
  if (Object.keys(diff).length > 0) throw new RestartChangedCounts(started.runId, diff);

  return {
    runId: started.runId,
    status: second,
    attempts: 2,
    workflowIds: [started.workflowId, bumped.workflowId],
    counts: after,
  };
}

/**
 * Waits for one attempt and refuses a `failed` one.
 *
 * Keyed on `current_workflow_id` rather than on the status: after a bump the row is `running`
 * again and settles back, so waiting on the status alone would match the first attempt's
 * conclusion, which is still there when the bump commits.
 */
async function settle(
  harness: FlowSyncHarness,
  runId: string,
  workflowId: string,
  attempt: number,
  timeoutMs: number,
): Promise<SettledRunStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await harness.pool.query<{ status: string; error: string | null }>(
      "SELECT status, error FROM hf_run WHERE run_id = $1 AND current_workflow_id = $2 " +
        "AND status <> 'running'",
      [runId, workflowId],
    );
    const row = rows[0];
    if (row !== undefined) {
      if (row.status === "failed") throw failureOf(runId, attempt, row.error);
      assertNoFencingFailure(harness.worker);
      return row.status as SettledRunStatus;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `runFlowSync: run ${runId} attempt ${attempt} (${workflowId}) never settled within ` +
          `${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * The second channel a fencing refusal arrives on: one a flow did not catch propagates out of
 * the workflow, and `defineFlow` writes it to `hf_run.error` as `${name}: ${message}`. Matching
 * the name prefix on that text is the only handle left by then — the error object itself never
 * crossed the process boundary.
 */
function failureOf(runId: string, attempt: number, error: string | null): Error {
  const message = error ?? "hf_run.error was null";
  const name = /^(UnfencedWrite|ControlPlaneInWorkflow): /.exec(message)?.[1];
  if (name === undefined) return new Error(message);
  return new FencingFailureInTest(`run ${runId} attempt ${attempt}`, [
    { name: name as "UnfencedWrite" | "ControlPlaneInWorkflow", detail: "", message },
  ]);
}

async function snapshotCounts(harness: FlowSyncHarness): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of [...RESTART_COUNTED_TABLES, ...(harness.tables ?? [])]) {
    counts[table] = await scalarCount(harness.pool, `SELECT count(*) AS n FROM "${table}"`);
  }
  counts[DOUBLE_CHARGE_COUNT_KEY] = await scalarCount(
    harness.pool,
    "SELECT count(*) AS n FROM hf_llm_call WHERE possible_double_charge",
  );
  return counts;
}

async function scalarCount(pool: Pool, sql: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(sql);
  return Number(rows[0]?.n ?? 0);
}
