import { createRequire } from "node:module";
import type { RunStatus } from "@hyperfixation/db";
import type { Pool } from "pg";

/** This package's own version, which `/api/status` reports as the core the app runs. */
export const CORE_VERSION = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

/**
 * Every read here is a plain `SELECT` and none of them locks anything — in particular not a
 * budget row, which is the one thing the lock order forbids any of these paths to take.
 */
const STATE_STATEMENT =
  "SELECT paused, paused_by, budget_usd::text AS budget_usd FROM hf_app_state WHERE id = 1";

const PERIODS_STATEMENT =
  "SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY-MM') AS current_period, " +
  "to_char(date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month', 'YYYY-MM') " +
  "AS previous_period";

const RUN_COUNTS_STATEMENT = "SELECT status, count(*)::int AS n FROM hf_run GROUP BY status";

const APPROVAL_COUNTS_STATEMENT =
  "SELECT status, count(*)::int AS n FROM hf_approval GROUP BY status";

const LEDGER_COUNTS_STATEMENT =
  "SELECT status, count(*)::int AS n FROM hf_llm_call GROUP BY status";

const ACTION_COUNTS_STATEMENT =
  "SELECT status, count(*)::int AS n FROM hf_action_log GROUP BY status";

/**
 * Queue depth from the workflow rows rather than from any counter: `ENQUEUED` is waiting and
 * `PENDING` is dispatched, and a queue whose concurrency is zero shows the backlog a pause is
 * holding back. Joined against `dbos.queues` so a queue with nothing on it still appears.
 */
const QUEUES_STATEMENT =
  "SELECT q.name, COALESCE(q.concurrency, -1)::int AS global_concurrency, " +
  "COALESCE(SUM((w.status = 'ENQUEUED')::int), 0)::int AS enqueued, " +
  "COALESCE(SUM((w.status = 'PENDING')::int), 0)::int AS running " +
  "FROM dbos.queues q LEFT JOIN dbos.workflow_status w ON w.queue_name = q.name " +
  "AND w.status IN ('ENQUEUED', 'PENDING') GROUP BY q.name, q.concurrency ORDER BY q.name";

/**
 * Per-period spend against budget, with the exact drift `reconcile()` reports and never
 * corrects: a call is billed to the period stamped on its own row, so this comparison is not
 * an estimate.
 */
const BUDGET_STATEMENT =
  "SELECT b.period, b.budget_usd::text AS budget_usd, b.spent_usd::text AS spent_usd, " +
  "COALESCE((SELECT SUM(l.cost_usd) FROM hf_llm_call l " +
  "WHERE l.period = b.period AND l.status = 'ok'), 0)::text AS ledger_usd " +
  "FROM hf_budget_period b WHERE b.period = ANY($1::text[])";

/**
 * `reconcile()`'s step (1) invariant violation, counted live rather than accumulated: a
 * `running` run with no `dbos.workflow_status` row at all cannot happen, because every path
 * that writes `current_workflow_id` enqueues in the same transaction.
 */
const ANOMALIES_STATEMENT =
  "SELECT count(*)::int AS n FROM hf_run r " +
  "LEFT JOIN dbos.workflow_status w ON w.workflow_uuid = r.current_workflow_id " +
  "WHERE r.status = 'running' AND w.workflow_uuid IS NULL";

export interface QueueStatus {
  name: string;
  /** `null` when the queue is registered with no global limit. */
  globalConcurrency: number | null;
  enqueued: number;
  running: number;
}

export interface PeriodStatus {
  period: string;
  budgetUsd: string;
  spentUsd: string;
  /** `SUM(cost_usd)` of the period's `ok` rows, for the drift below. */
  ledgerUsd: string;
  driftUsd: string;
}

export interface StatusReport {
  /** `degraded` when there are anomalies or any period's spend disagrees with its ledger. */
  health: "ok" | "degraded";
  app: string;
  applicationVersion: string | null;
  coreVersion: string;
  paused: boolean;
  pausedBy: string | null;
  runs: Record<RunStatus, number>;
  queues: QueueStatus[];
  approvals: Record<string, number>;
  llmCalls: Record<string, number>;
  actions: Record<string, number>;
  budget: { current: PeriodStatus | null; previous: PeriodStatus | null };
  anomalies: number;
  at: string;
}

const RUN_STATUSES: readonly RunStatus[] = ["running", "waiting", "paused", "done", "failed"];

export interface StatusOptions {
  app: string;
  applicationVersion: string | null;
}

/** What `GET /api/status` answers with, and what `hf doctor` reads. */
export async function appStatus(pool: Pool, options: StatusOptions): Promise<StatusReport> {
  const [state, periods, runs, approvals, llmCalls, actions, queues, anomalies] = await Promise.all(
    [
      pool.query<{ paused: boolean; paused_by: string | null; budget_usd: string }>(
        STATE_STATEMENT,
      ),
      pool.query<{ current_period: string; previous_period: string }>(PERIODS_STATEMENT),
      counts(pool, RUN_COUNTS_STATEMENT),
      counts(pool, APPROVAL_COUNTS_STATEMENT),
      counts(pool, LEDGER_COUNTS_STATEMENT),
      counts(pool, ACTION_COUNTS_STATEMENT),
      pool.query<{
        name: string;
        global_concurrency: number;
        enqueued: number;
        running: number;
      }>(QUEUES_STATEMENT),
      pool.query<{ n: number }>(ANOMALIES_STATEMENT),
    ],
  );

  const { current_period: current, previous_period: previous } = periods.rows[0]!;
  const budget = await pool.query<{
    period: string;
    budget_usd: string;
    spent_usd: string;
    ledger_usd: string;
  }>(BUDGET_STATEMENT, [[current, previous]]);
  const periodStatus = (period: string): PeriodStatus | null => {
    const row = budget.rows.find((candidate) => candidate.period === period);
    if (row === undefined) return null;
    return {
      period: row.period,
      budgetUsd: row.budget_usd,
      spentUsd: row.spent_usd,
      ledgerUsd: row.ledger_usd,
      driftUsd: (Number(row.spent_usd) - Number(row.ledger_usd)).toFixed(6),
    };
  };

  const budgetStatus = { current: periodStatus(current), previous: periodStatus(previous) };
  const drifting = [budgetStatus.current, budgetStatus.previous].some(
    (period) => period !== null && Number(period.driftUsd) !== 0,
  );
  const anomalyCount = anomalies.rows[0]!.n;

  return {
    health: anomalyCount === 0 && !drifting ? "ok" : "degraded",
    app: options.app,
    applicationVersion: options.applicationVersion,
    coreVersion: CORE_VERSION,
    paused: state.rows[0]?.paused ?? false,
    pausedBy: state.rows[0]?.paused_by ?? null,
    runs: Object.fromEntries(
      RUN_STATUSES.map((status) => [status, runs[status] ?? 0]),
    ) as Record<RunStatus, number>,
    queues: queues.rows.map((row) => ({
      name: row.name,
      // `-1` is the COALESCE above standing in for a NULL `concurrency`, which is "no limit".
      globalConcurrency: row.global_concurrency < 0 ? null : row.global_concurrency,
      enqueued: row.enqueued,
      running: row.running,
    })),
    approvals,
    llmCalls,
    actions,
    budget: budgetStatus,
    anomalies: anomalyCount,
    at: new Date().toISOString(),
  };
}

async function counts(pool: Pool, statement: string): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ status: string; n: number }>(statement);
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}
