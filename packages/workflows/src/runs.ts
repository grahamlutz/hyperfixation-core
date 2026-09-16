import { randomUUID } from "node:crypto";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { attemptWorkflowId, controlPlaneTx } from "@hyperfixation/db";
import type { Pool } from "pg";
import type { Flow } from "./define-flow.js";

export const START_RUN_STATEMENT =
  "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
  "VALUES ($1, $2, $3, 'running', 1, $4)";

export interface RunsStartOptions {
  /** A fresh id is generated when omitted. */
  runId?: string;
}

export interface StartedRun {
  runId: string;
  workflowId: string;
}

/**
 * The only way a run begins: insert the `hf_run` row at attempt 1 and enqueue its first
 * workflow in the same transaction, so the row and the workflow exist together or not at all.
 * A control-plane operation — callable from the web (no run is in flight yet to forbid it).
 */
export async function runsStart<I>(
  pool: Pool,
  dbosClient: DBOSClient,
  flow: Flow<I, unknown>,
  input: I,
  options: RunsStartOptions = {},
): Promise<StartedRun> {
  const runId = options.runId ?? randomUUID();
  const workflowId = attemptWorkflowId(runId, 1);

  return controlPlaneTx(pool, { operation: "runs.start" }, async (client) => {
    await client.query(START_RUN_STATEMENT, [runId, flow.name, JSON.stringify(input), workflowId]);
    await dbosClient.enqueueInTransaction(
      client,
      { queueName: flow.queue, workflowName: flow.name, workflowID: workflowId },
      { runId, attempt: 1, input },
    );
    return { runId, workflowId };
  });
}
