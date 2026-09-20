import type { Pool } from "pg";
import {
  DEFAULT_WAIT_FOR_RUN_INTERVAL_MS,
  DEFAULT_WAIT_FOR_RUN_TIMEOUT_MS,
  type WaitForRunOptions,
} from "./wait-for-run.js";

/** The `dbos.workflow_status` columns a test waits on; the row as it stood at the last poll. */
export interface WorkflowState {
  workflowId: string;
  status: string;
  applicationVersion: string | null;
}

const SELECT_WORKFLOW =
  "SELECT workflow_uuid, status, application_version FROM dbos.workflow_status " +
  "WHERE workflow_uuid = $1";

export class WorkflowNeverMatched extends Error {
  readonly workflowId: string;
  /** The row at the last poll before the deadline; undefined when no row ever existed. */
  readonly lastSeen: WorkflowState | undefined;

  constructor(workflowId: string, status: string, timeoutMs: number, lastSeen?: WorkflowState) {
    super(
      `WorkflowNeverMatched: workflow ${workflowId} never reached ${status} within ${timeoutMs}ms; ` +
        `last seen ${
          lastSeen === undefined
            ? "no dbos.workflow_status row"
            : `status=${lastSeen.status} application_version=${lastSeen.applicationVersion ?? "null"}`
        }`,
    );
    this.name = "WorkflowNeverMatched";
    this.workflowId = workflowId;
    this.lastSeen = lastSeen;
  }
}

/**
 * Polls `dbos.workflow_status` until the workflow reaches `status`, and answers with the row.
 *
 * The poll is the point, and `waitForRun` is not a substitute for it: every `hf_run` status the
 * wrapper writes — `done`, `failed`, `waiting`, `paused` — is committed from *inside* the
 * workflow body, so DBOS only writes the attempt's terminal status after the body returns. A
 * test that reads this table once, the moment `hf_run` settles, is reading it inside that gap
 * and sees `PENDING`.
 */
export async function waitForWorkflowStatus(
  pool: Pool,
  workflowId: string,
  status: string,
  options: WaitForRunOptions = {},
): Promise<WorkflowState> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_FOR_RUN_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_WAIT_FOR_RUN_INTERVAL_MS;

  const deadline = Date.now() + timeoutMs;
  let lastSeen: WorkflowState | undefined;
  for (;;) {
    const { rows } = await pool.query<WorkflowQueryRow>(SELECT_WORKFLOW, [workflowId]);
    const row = rows[0];
    if (row !== undefined) {
      lastSeen = {
        workflowId: row.workflow_uuid,
        status: row.status,
        applicationVersion: row.application_version,
      };
      if (lastSeen.status === status) return lastSeen;
    }
    if (Date.now() > deadline) {
      throw new WorkflowNeverMatched(workflowId, status, timeoutMs, lastSeen);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

interface WorkflowQueryRow {
  workflow_uuid: string;
  status: string;
  application_version: string | null;
}
