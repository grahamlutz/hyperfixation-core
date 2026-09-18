import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { bumpAttempt, type BumpedAttempt } from "@hyperfixation/db";
import type { ClientBase } from "pg";
import { definedFlows } from "./define-flow.js";

export class UnknownFlow extends Error {
  readonly runId: string;

  constructor(runId: string, flow: string) {
    super(
      `UnknownFlow: hf_run ${runId} names flow ${JSON.stringify(flow)}, which this worker does ` +
        "not register; its next attempt has no queue to be enqueued on",
    );
    this.name = "UnknownFlow";
    this.runId = runId;
  }
}

/**
 * The one attempt-bump path with its enqueue, on a client already inside a control-plane
 * transaction: `reconcile()` opens one per run, `decide()` bumps inside the transaction that
 * writes the decision, and neither has a bump of its own. The queue name comes from the flow
 * registry and from nowhere else (round-2 finding 2).
 */
export async function bumpAndEnqueueOn(
  client: ClientBase,
  dbosClient: DBOSClient,
  runId: string,
): Promise<BumpedAttempt> {
  const bumped = await bumpAttempt(client, runId);
  const flow = flowForRun(runId, bumped.flow);
  await dbosClient.enqueueInTransaction(
    client,
    { queueName: flow.queue, workflowName: flow.name, workflowID: bumped.workflowId },
    { runId, attempt: bumped.attempt, input: bumped.input },
  );
  return bumped;
}

export function flowForRun(runId: string, name: string): { name: string; queue: string } {
  const flow = definedFlows().get(name);
  if (flow === undefined) throw new UnknownFlow(runId, name);
  return flow;
}
