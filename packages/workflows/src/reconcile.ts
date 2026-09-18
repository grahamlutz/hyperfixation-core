import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  appPaused,
  assertNotInWorkflow,
  controlPlaneTx,
  type BumpedAttempt,
} from "@hyperfixation/db";
import type { Pool, PoolClient } from "pg";
import { decide } from "./approvals.js";
import { bumpAndEnqueueOn, flowForRun } from "./bump.js";
import { PAUSED_CONCURRENCY, PAUSED_QUEUES, registeredConcurrency } from "./queue-concurrency.js";
import { concludeRun } from "./run-status.js";
import type { QueueName } from "./start-worker.js";

/** How often the worker runs a pass after the one it runs at boot. */
export const RECONCILE_INTERVAL_MS = 60_000;

/**
 * A `running` run whose `current_workflow_id` has no `dbos.workflow_status` row at all. Every
 * path that writes the column enqueues in the same transaction, so this cannot happen — it is
 * logged at error and counted rather than swallowed, and the attempt is enqueued anyway.
 */
export const RECONCILE_ANOMALY_MARKER = "hf-reconcile: a running run has no workflow row";

/** One line per run a pass could not finish; the pass carries on with the others. */
export const RECONCILE_FAILED_MARKER = "hf-reconcile: run refused";

/**
 * One line per run a pass moved, carrying the `run_id`. The pass summary alone would make a
 * redeploy that moved a whole backlog a single number, with no way back to which run went where.
 */
export const RECONCILE_ACTION_MARKER = "hf-reconcile: run moved";

/**
 * One line per queue a pass re-derived from `hf_app_state.paused`, carrying both concurrencies.
 * Its own marker rather than the action one: nothing about it is a run, and a stall this fixed
 * is diagnosed by reading which direction it went.
 */
export const RECONCILE_QUEUE_MARKER = "hf-reconcile: queue concurrency corrected";

/** One line per pass, carrying the report. */
export const RECONCILE_PASS_MARKER = "hf-reconcile: pass";

/** DBOS statuses that mean the attempt has not run yet or is believed to be running. */
const LIVE_DBOS_STATUSES = ["PENDING", "ENQUEUED", "DELAYED"];

/**
 * The drift scan. `reconcile()` reports it and never corrects it: correcting a counter is how
 * round-2 finding 3 happened, and per-period drift is exact because a call is billed to the
 * period stamped on its own row.
 */
export const DRIFT_STATEMENT =
  "SELECT b.period, b.spent_usd::text AS spent_usd, " +
  "COALESCE((SELECT SUM(l.cost_usd) FROM hf_llm_call l " +
  "WHERE l.period = b.period AND l.status = 'ok'), 0)::text AS ledger_usd " +
  "FROM hf_budget_period b ORDER BY b.period";

/**
 * Step (1)'s scan. A plain `SELECT`, joined against `dbos.workflow_status` rather than asking
 * the SDK per run: one statement for the whole scan, and the application role reads that table
 * under the grants E006 checks.
 */
export const RUNNING_RUNS_STATEMENT =
  "SELECT r.run_id, r.attempt, r.current_workflow_id, w.status AS dbos_status, " +
  "w.application_version, w.error AS dbos_error " +
  "FROM hf_run r LEFT JOIN dbos.workflow_status w ON w.workflow_uuid = r.current_workflow_id " +
  "WHERE r.status = 'running' ORDER BY r.run_id";

/** Step (3)'s scan: runs parked by a pause the app has since come out of. */
export const PAUSED_RUNS_STATEMENT =
  "SELECT r.run_id FROM hf_run r WHERE r.status = 'paused' " +
  "AND NOT COALESCE((SELECT paused FROM hf_app_state WHERE id = 1), false) ORDER BY r.run_id";

/**
 * Step (4), ledger half. Round 3 widened the predicate twice over round 2: to `running` runs'
 * non-current rows, and to every row on a `waiting`/`paused` run, whose current workflow has
 * ended so nothing can still be in flight. Idempotent because the predicate is the status.
 *
 * Hygiene and audit, not budget correctness — none of these rows reserves anything by the time
 * this runs, because the reservation only ever counts rows whose `workflow_id` is still their
 * run's `current_workflow_id` on a `running` run.
 */
export const ABANDON_LLM_CALLS_STATEMENT =
  "UPDATE hf_llm_call l SET status = 'abandoned', finished_at = now() FROM hf_run r " +
  "WHERE l.run_id = r.run_id AND l.status = 'started' " +
  "AND (r.status IN ('done', 'failed', 'waiting', 'paused') " +
  "OR l.workflow_id <> r.current_workflow_id)";

/** Step (4), actions half: the same predicate, into the status that already means this. */
export const UNCERTAIN_ACTIONS_STATEMENT =
  "UPDATE hf_action_log a SET status = 'uncertain', finished_at = now() FROM hf_run r " +
  "WHERE a.run_id = r.run_id AND a.status = 'started' " +
  "AND (r.status IN ('done', 'failed', 'waiting', 'paused') " +
  "OR a.workflow_id <> r.current_workflow_id)";

/**
 * Step (5)'s scan. A plain `SELECT`: `decide()` locks what it decides, and an approval this
 * scan read a moment before someone decided it is simply not pending any more by then.
 */
export const EXPIRED_APPROVALS_STATEMENT =
  "SELECT id, run_id FROM hf_approval WHERE status = 'pending' " +
  "AND expires_at IS NOT NULL AND expires_at <= now() ORDER BY id";

/** Re-read under `FOR UPDATE` before the anomaly branch enqueues the id it already carries. */
const LOCK_RUN_FOR_ANOMALY_STATEMENT =
  "SELECT attempt, current_workflow_id, flow, input, status FROM hf_run " +
  "WHERE run_id = $1 FOR UPDATE";

const WORKFLOW_ID_TAKEN_STATEMENT = "SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid = $1";

export interface ReconcileOptions {
  /** The version this worker runs; an attempt under any other one is dead. */
  applicationVersion: string;
  /** A Postgres interval literal handed to every transaction of the pass. */
  lockTimeout?: string;
}

export interface Reattempted {
  runId: string;
  attempt: number;
  workflowId: string;
  /** What the previous attempt was doing when the pass found it. */
  reason: "dead-version" | "cancelled" | "resumed";
}

export interface Concluded {
  runId: string;
  status: "done" | "failed";
  dbosStatus: string;
}

export interface ReconcileAnomaly {
  runId: string;
  workflowId: string;
  /** False when the enqueue itself was refused; the anomaly is counted either way. */
  enqueued: boolean;
}

export interface ReconcileFailure {
  /** Null on a failure no run owns; step (6)'s subject is the app's queues, not a run. */
  runId: string | null;
  step: "reattempt" | "conclude" | "resume" | "anomaly" | "expire" | "queues";
  error: string;
}

export interface ExpiredApproval {
  approvalId: number;
  runId: string;
  /** The attempt `decide()` enqueued to tell the run its approval expired. */
  workflowId: string;
}

export interface QueueConcurrencyCorrection {
  name: QueueName;
  /** `hf_app_state.paused` as this pass read it, which is what the correction was against. */
  paused: boolean;
  /** What the queue's row said before the pass wrote it; `null` is a registered no-limit. */
  was: number | null;
  now: number;
}

export interface PeriodDrift {
  period: string;
  spentUsd: string;
  ledgerUsd: string;
  driftUsd: string;
}

export interface ReconcileReport {
  reattempted: Reattempted[];
  concluded: Concluded[];
  anomalies: ReconcileAnomaly[];
  abandonedLlmCalls: number;
  uncertainActions: number;
  expired: ExpiredApproval[];
  queueConcurrency: QueueConcurrencyCorrection[];
  drift: PeriodDrift[];
  failures: ReconcileFailure[];
}

interface RunningRunRow {
  run_id: string;
  attempt: number;
  current_workflow_id: string;
  dbos_status: string | null;
  application_version: string | null;
  dbos_error: string | null;
}

/**
 * The app-level half of a redeploy: DBOS's own recovery is version- and executor-scoped, so an
 * old version's workflows are never touched by a new worker. This is what moves those runs on.
 *
 * A control-plane operation — control pool, `assertNotInWorkflow()`, every transaction through
 * the tag-asserting helper — and it **never locks `hf_budget_period`**: its drift read is a
 * plain `SELECT`, which is what keeps the lock order `hf_run → hf_budget_period → ledger` free
 * of a cycle (round-3 finding 8).
 *
 * One run's refusal never ends the pass: the runs are independent, and a pass that stopped at
 * the first one would leave the rest of a backlog stranded until the defect was fixed.
 *
 * Steps (1), (3), (4), (5) and (6) and the drift read; step (2) is deleted, not re-predicated —
 * the enqueue is in the bump's own transaction, so there is no commit-to-enqueue window to
 * backstop.
 */
export async function reconcile(
  pool: Pool,
  dbosClient: DBOSClient,
  options: ReconcileOptions,
): Promise<ReconcileReport> {
  assertNotInWorkflow("reconcile");

  const report: ReconcileReport = {
    reattempted: [],
    concluded: [],
    anomalies: [],
    abandonedLlmCalls: 0,
    uncertainActions: 0,
    expired: [],
    queueConcurrency: [],
    drift: [],
    failures: [],
  };

  const running = await pool.query<RunningRunRow>(RUNNING_RUNS_STATEMENT);
  for (const row of running.rows) {
    await reconcileRunningRun(pool, dbosClient, options, row, report);
  }

  const paused = await pool.query<{ run_id: string }>(PAUSED_RUNS_STATEMENT);
  for (const row of paused.rows) {
    try {
      const bumped = await bumpAndEnqueue(pool, dbosClient, row.run_id, options);
      recordReattempt(report, bumped, "resumed");
    } catch (error) {
      recordFailure(report, row.run_id, "resume", error);
    }
  }

  const hygiene = await controlPlaneTx(
    pool,
    { operation: "reconcile.hygiene", ...lockTimeoutOf(options) },
    async (client) => {
      const calls = await client.query(ABANDON_LLM_CALLS_STATEMENT);
      const actions = await client.query(UNCERTAIN_ACTIONS_STATEMENT);
      return { calls: calls.rowCount ?? 0, actions: actions.rowCount ?? 0 };
    },
  );
  report.abandonedLlmCalls = hygiene.calls;
  report.uncertainActions = hygiene.actions;

  await reconcileQueueConcurrency(pool, dbosClient, report);

  const drift = await pool.query<{ period: string; spent_usd: string; ledger_usd: string }>(
    DRIFT_STATEMENT,
  );
  report.drift = drift.rows.map((row) => ({
    period: row.period,
    spentUsd: row.spent_usd,
    ledgerUsd: row.ledger_usd,
    driftUsd: (Number(row.spent_usd) - Number(row.ledger_usd)).toFixed(6),
  }));

  await expireApprovals(pool, dbosClient, options, report);

  console.info(RECONCILE_PASS_MARKER, JSON.stringify(summaryOf(report)));
  return report;
}

/**
 * Step (6). `pause`/`resume` write the flag and the queues in two statements and `startWorker()`
 * reads the flag and writes the queues in two more, so a resume landing inside a booting
 * worker's window leaves `paused = false` with `llm` and `actions` pinned at zero: runs enqueued
 * behind a dequeue that claims nothing, and `/api/status` reporting `ok` because it grades health
 * on anomalies and budget drift alone. Nothing else notices, so every pass re-derives the queues
 * from the flag — including `startWorker()`'s own boot pass, which runs after that window.
 *
 * Only the two disagreements that race produces are corrected. A non-zero concurrency that is
 * merely not the registered one is somebody's tuning, and a pass that overwrote it every minute
 * would be a worse defect than the stall it fixes.
 *
 * The flag is read the way step (3) reads it — a plain `SELECT`, no lock, no transaction of its
 * own — so this step takes nothing the lock order has an opinion about. One queue's refusal
 * never ends the pass, for the reason every other step's does not.
 */
async function reconcileQueueConcurrency(
  pool: Pool,
  dbosClient: DBOSClient,
  report: ReconcileReport,
): Promise<void> {
  const paused = await appPaused(pool);
  for (const name of PAUSED_QUEUES) {
    try {
      const queue = await dbosClient.retrieveQueue(name);
      // No row at all: no worker has ever launched, so there is no live concurrency to disagree
      // with the flag, and `startWorker()` applies it on the way up.
      if (queue === null) continue;

      const was = (await queue.getGlobalConcurrency()) ?? null;
      const stuck = !paused && was === PAUSED_CONCURRENCY;
      // A NULL concurrency is "no limit", which is the loudest form of still dispatching.
      const dispatching = paused && was !== PAUSED_CONCURRENCY;
      if (!stuck && !dispatching) continue;

      const now = paused ? PAUSED_CONCURRENCY : registeredConcurrency(name);
      await queue.setGlobalConcurrency(now);
      const corrected: QueueConcurrencyCorrection = { name, paused, was, now };
      console.info(RECONCILE_QUEUE_MARKER, JSON.stringify(corrected));
      report.queueConcurrency.push(corrected);
    } catch (error) {
      recordFailure(report, null, "queues", namingQueue(name, error));
    }
  }
}

/** Keeps the queue on a failure whose `runId` is null because no run owns it. */
function namingQueue(name: QueueName, error: unknown): Error {
  const thrown = error as Error | undefined;
  const named = new Error(`${name}: ${thrown?.message ?? String(error)}`);
  named.name = thrown?.name ?? "Error";
  return named;
}

/**
 * Step (5). There is no separate sweep: an expiry is a decision like any other, so it goes
 * through `decide()` and gets its bump, its resume workflow and its audit row from the same
 * transaction as a human's. One approval per call — a batch would make one bad row strand the
 * rest — and the `decisionKey` is the approval's own id, so a pass that died after the commit
 * replays instead of deciding twice.
 */
async function expireApprovals(
  pool: Pool,
  dbosClient: DBOSClient,
  options: ReconcileOptions,
  report: ReconcileReport,
): Promise<void> {
  const expiring = await pool.query<{ id: string; run_id: string }>(EXPIRED_APPROVALS_STATEMENT);
  for (const row of expiring.rows) {
    const approvalId = Number(row.id);
    try {
      const result = await decide(pool, dbosClient, {
        ids: [approvalId],
        decision: "expired",
        via: "sweep",
        decisionKey: sweepDecisionKey(approvalId),
        ...lockTimeoutOf(options),
      });
      for (const decided of result.decided) {
        const expired: ExpiredApproval = {
          approvalId: decided.approvalId,
          runId: decided.runId,
          workflowId: decided.resumeWorkflowId,
        };
        console.info(RECONCILE_ACTION_MARKER, JSON.stringify({ action: "expire", ...expired }));
        report.expired.push(expired);
      }
    } catch (error) {
      recordFailure(report, row.run_id, "expire", error);
    }
  }
}

/** Stable across passes, so a re-decided row is a replay rather than a second decision. */
export function sweepDecisionKey(approvalId: number): string {
  return `sweep:${approvalId}`;
}

async function reconcileRunningRun(
  pool: Pool,
  dbosClient: DBOSClient,
  options: ReconcileOptions,
  row: RunningRunRow,
  report: ReconcileReport,
): Promise<void> {
  if (row.dbos_status === null) {
    await recordAnomaly(pool, dbosClient, options, row, report);
    return;
  }

  if (row.dbos_status === "SUCCESS" || isTerminalFailure(row.dbos_status)) {
    // The workflow ended but the run was never marked: the wrapper's own status write is the
    // last thing it does, so this is the crash window between the two.
    const status = row.dbos_status === "SUCCESS" ? "done" : "failed";
    try {
      await concludeRun(
        pool,
        row.run_id,
        row.current_workflow_id,
        status,
        status === "failed" ? (row.dbos_error ?? `the workflow ended ${row.dbos_status}`) : null,
      );
      const concluded: Concluded = { runId: row.run_id, status, dbosStatus: row.dbos_status };
      console.info(RECONCILE_ACTION_MARKER, JSON.stringify({ action: "conclude", ...concluded }));
      report.concluded.push(concluded);
    } catch (error) {
      recordFailure(report, row.run_id, "conclude", error);
    }
    return;
  }

  // A cancelled current attempt is this pass's own crash window: step (1) cancels and then
  // bumps, so a pass that died between the two leaves exactly this. Re-attempting is the same
  // condition as a dead version — the attempt cannot run — and never marks the run terminal.
  if (row.dbos_status === "CANCELLED") {
    await reattempt(pool, dbosClient, options, row, report, "cancelled");
    return;
  }

  // An enqueue from a control-plane transaction carries no `application_version` (the SDK takes
  // it from the client, and a client has none), so a NULL is an attempt any version may dequeue
  // — including one this pass enqueued a moment ago. Only a version that is present and not
  // ours is dead, or the reconciler would bump its own work forever.
  const dead =
    LIVE_DBOS_STATUSES.includes(row.dbos_status) &&
    row.application_version !== null &&
    row.application_version !== options.applicationVersion;
  if (!dead) return;

  try {
    await dbosClient.cancelWorkflow(row.current_workflow_id);
  } catch (error) {
    recordFailure(report, row.run_id, "reattempt", error);
    return;
  }
  await reattempt(pool, dbosClient, options, row, report, "dead-version");
}

async function reattempt(
  pool: Pool,
  dbosClient: DBOSClient,
  options: ReconcileOptions,
  row: RunningRunRow,
  report: ReconcileReport,
  reason: Reattempted["reason"],
): Promise<void> {
  try {
    const bumped = await bumpAndEnqueue(pool, dbosClient, row.run_id, options);
    recordReattempt(report, bumped, reason);
  } catch (error) {
    recordFailure(report, row.run_id, "reattempt", error);
  }
}

/** One run's bump in its own control-plane transaction, around the shared bump path. */
async function bumpAndEnqueue(
  pool: Pool,
  dbosClient: DBOSClient,
  runId: string,
  options: ReconcileOptions,
): Promise<BumpedAttempt> {
  return controlPlaneTx(
    pool,
    { operation: "reconcile.bump", ...lockTimeoutOf(options) },
    async (client) => bumpAndEnqueueOn(client, dbosClient, runId),
  );
}

/**
 * The invariant violation. The run is left on the attempt it already has — the id is fresh by
 * construction, so what is missing is the enqueue, not the attempt — and the enqueue is redone
 * under the run's own lock so a concurrent bump cannot be enqueued over.
 */
async function recordAnomaly(
  pool: Pool,
  dbosClient: DBOSClient,
  options: ReconcileOptions,
  row: RunningRunRow,
  report: ReconcileReport,
): Promise<void> {
  console.error(
    RECONCILE_ANOMALY_MARKER,
    JSON.stringify({ runId: row.run_id, workflowId: row.current_workflow_id }),
  );

  try {
    const enqueued = await controlPlaneTx(
      pool,
      { operation: "reconcile.anomaly", ...lockTimeoutOf(options) },
      async (client) => enqueueCurrentAttempt(client, dbosClient, row),
    );
    report.anomalies.push({
      runId: row.run_id,
      workflowId: row.current_workflow_id,
      enqueued,
    });
  } catch (error) {
    report.anomalies.push({
      runId: row.run_id,
      workflowId: row.current_workflow_id,
      enqueued: false,
    });
    recordFailure(report, row.run_id, "anomaly", error);
  }
}

async function enqueueCurrentAttempt(
  client: PoolClient,
  dbosClient: DBOSClient,
  row: RunningRunRow,
): Promise<boolean> {
  const locked = await client.query<{
    attempt: number;
    current_workflow_id: string;
    flow: string;
    input: unknown;
    status: string;
  }>(LOCK_RUN_FOR_ANOMALY_STATEMENT, [row.run_id]);
  const run = locked.rows[0];
  // The scan was a plain read; anything that moved the run since owns it now.
  if (
    run === undefined ||
    run.status !== "running" ||
    run.current_workflow_id !== row.current_workflow_id
  ) {
    return false;
  }

  const taken = await client.query(WORKFLOW_ID_TAKEN_STATEMENT, [row.current_workflow_id]);
  if (taken.rowCount !== 0) return false;

  const flow = flowForRun(row.run_id, run.flow);
  await dbosClient.enqueueInTransaction(
    client,
    { queueName: flow.queue, workflowName: flow.name, workflowID: run.current_workflow_id },
    { runId: row.run_id, attempt: run.attempt, input: run.input },
  );
  return true;
}

function isTerminalFailure(dbosStatus: string): boolean {
  return dbosStatus === "ERROR" || dbosStatus === "MAX_RECOVERY_ATTEMPTS_EXCEEDED";
}

function recordReattempt(
  report: ReconcileReport,
  bumped: BumpedAttempt,
  reason: Reattempted["reason"],
): void {
  const reattempted: Reattempted = {
    runId: bumped.runId,
    attempt: bumped.attempt,
    workflowId: bumped.workflowId,
    reason,
  };
  console.info(RECONCILE_ACTION_MARKER, JSON.stringify({ action: "reattempt", ...reattempted }));
  report.reattempted.push(reattempted);
}

function lockTimeoutOf(options: ReconcileOptions): { lockTimeout?: string } {
  return options.lockTimeout === undefined ? {} : { lockTimeout: options.lockTimeout };
}

function recordFailure(
  report: ReconcileReport,
  runId: string | null,
  step: ReconcileFailure["step"],
  error: unknown,
): void {
  const thrown = error as Error | undefined;
  const message = `${thrown?.name ?? "Error"}: ${thrown?.message ?? String(error)}`;
  console.error(RECONCILE_FAILED_MARKER, JSON.stringify({ runId, step, error: message }));
  report.failures.push({ runId, step, error: message });
}

function summaryOf(report: ReconcileReport): Record<string, number> {
  return {
    reattempted: report.reattempted.length,
    concluded: report.concluded.length,
    anomalies: report.anomalies.length,
    abandonedLlmCalls: report.abandonedLlmCalls,
    uncertainActions: report.uncertainActions,
    expired: report.expired.length,
    queueConcurrency: report.queueConcurrency.length,
    failures: report.failures.length,
  };
}

export interface Reconciler {
  /** Stops the interval; the pass already in flight is left to finish. */
  stop(): void;
}

/**
 * The every-minute schedule. A plain timer rather than a DBOS scheduled workflow: DBOS's
 * scheduler runs its functions *as workflows*, and `reconcile()` is a control-plane operation
 * that `assertNotInWorkflow()` refuses from inside one (round-3 finding 2).
 *
 * Passes never overlap — a pass that outruns the interval would have two reconcilers bumping
 * the same backlog — and a failed pass is logged, never thrown: there is no caller left to
 * throw to, and the next pass reconciles whatever this one did not.
 */
export function startReconciler(
  pool: Pool,
  dbosClient: DBOSClient,
  options: ReconcileOptions & { intervalMs?: number },
): Reconciler {
  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await reconcile(pool, dbosClient, options);
    } catch (error) {
      console.error(RECONCILE_FAILED_MARKER, error);
    } finally {
      running = false;
    }
  };

  // `unref` so the reconciler is never itself the reason a process stays up.
  const timer = setInterval(() => void pass(), options.intervalMs ?? RECONCILE_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
