import type { Pool } from "pg";

/** The `hf_run` columns a test waits on; the row as it stood at the last poll. */
export interface RunState {
  runId: string;
  status: string;
  attempt: number;
  currentWorkflowId: string;
  error: string | null;
  finishedAt: Date | null;
}

/** A status to wait for, or the whole row when "done" alone is not the condition. */
export type RunCondition = string | ((run: RunState) => boolean);

export interface WaitForRunOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export const DEFAULT_WAIT_FOR_RUN_TIMEOUT_MS = 60_000;
export const DEFAULT_WAIT_FOR_RUN_INTERVAL_MS = 100;

const SELECT_RUN =
  "SELECT run_id, status, attempt, current_workflow_id, error, finished_at FROM hf_run " +
  "WHERE run_id = $1";

export class RunNeverMatched extends Error {
  readonly runId: string;
  /** The row at the last poll before the deadline; undefined when no row ever existed. */
  readonly lastSeen: RunState | undefined;

  constructor(runId: string, condition: RunCondition, timeoutMs: number, lastSeen?: RunState) {
    super(
      `RunNeverMatched: run ${runId} never ${
        typeof condition === "string" ? `reached ${condition}` : "matched the predicate"
      } within ${timeoutMs}ms; last seen ${
        lastSeen === undefined ? "no hf_run row" : describe(lastSeen)
      }`,
    );
    this.name = "RunNeverMatched";
    this.runId = runId;
    this.lastSeen = lastSeen;
  }
}

/**
 * Polls `hf_run` until the run matches, and answers with the row that matched.
 *
 * A status string is the common case; a predicate is for a condition the status alone cannot
 * express — an attempt number, or a `done` that belongs to the second attempt rather than the
 * first, which is what `current_workflow_id` distinguishes.
 */
export async function waitForRun(
  pool: Pool,
  runId: string,
  condition: RunCondition,
  options: WaitForRunOptions = {},
): Promise<RunState> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_FOR_RUN_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_WAIT_FOR_RUN_INTERVAL_MS;
  const matches =
    typeof condition === "string" ? (run: RunState) => run.status === condition : condition;

  const deadline = Date.now() + timeoutMs;
  let lastSeen: RunState | undefined;
  for (;;) {
    const { rows } = await pool.query<RunQueryRow>(SELECT_RUN, [runId]);
    const row = rows[0];
    if (row !== undefined) {
      lastSeen = {
        runId: row.run_id,
        status: row.status,
        attempt: row.attempt,
        currentWorkflowId: row.current_workflow_id,
        error: row.error,
        finishedAt: row.finished_at,
      };
      if (matches(lastSeen)) return lastSeen;
    }
    if (Date.now() > deadline) throw new RunNeverMatched(runId, condition, timeoutMs, lastSeen);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function describe(run: RunState): string {
  return (
    `status=${run.status} attempt=${run.attempt} workflow=${run.currentWorkflowId}` +
    ` finished_at=${run.finishedAt === null ? "null" : run.finishedAt.toISOString()}` +
    (run.error === null ? "" : ` error=${run.error}`)
  );
}

interface RunQueryRow {
  run_id: string;
  status: string;
  attempt: number;
  current_workflow_id: string;
  error: string | null;
  finished_at: Date | null;
}
