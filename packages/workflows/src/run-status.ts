import type { RunStatus } from "@hyperfixation/db";
import type { Pool } from "pg";

/** The wrapper's first statement; `version` stamps the SHA the attempt actually ran under. */
export const CLAIM_RUN_STATEMENT =
  "UPDATE hf_run SET status = 'running', version = $2 " +
  "WHERE run_id = $1 AND current_workflow_id = $3";

/** `finished_at` is only a conclusion: a `waiting`/`paused` run is still going. */
export const CONCLUDE_RUN_STATEMENT =
  "UPDATE hf_run SET status = $2, error = $3, " +
  "finished_at = CASE WHEN $2 IN ('done', 'failed') THEN now() ELSE NULL END " +
  "WHERE run_id = $1 AND current_workflow_id = $4";

/** Logged whenever a fenced status write matched no row; the run has moved on without it. */
export const RUN_STATUS_REFUSED_MARKER = "hf-run: status write refused, the run moved on";

/**
 * Both writes go straight at the control pool rather than through `controlPlaneTx`: they are
 * issued from inside a workflow, which `assertNotInWorkflow()` refuses by design. A single
 * `UPDATE` is its own transaction, so the helper's commit assert has nothing to add — what
 * makes these safe is the `AND current_workflow_id = …` fence, which every one of them
 * carries, so a superseded attempt's write matches no row instead of overwriting a run that
 * a bump has already moved to its next attempt.
 */
export async function claimRun(
  pool: Pool,
  runId: string,
  workflowId: string,
  version: string,
): Promise<boolean> {
  const claimed = await pool.query(CLAIM_RUN_STATEMENT, [runId, version, workflowId]);
  return claimed.rowCount === 1;
}

export async function concludeRun(
  pool: Pool,
  runId: string,
  workflowId: string,
  status: RunStatus,
  error: string | null,
): Promise<boolean> {
  const written = await pool.query(CONCLUDE_RUN_STATEMENT, [runId, status, error, workflowId]);
  if (written.rowCount === 1) return true;
  console.info(RUN_STATUS_REFUSED_MARKER, JSON.stringify({ runId, workflowId, status }));
  return false;
}
