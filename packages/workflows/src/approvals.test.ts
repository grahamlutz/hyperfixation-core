import { DBOS, type DBOSClient } from "@dbos-inc/dbos-sdk";
import { ControlPlaneInWorkflow } from "@hyperfixation/db";
import { asRole, createTestDatabase, testBuildSha, type TestDatabase } from "@hyperfixation/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalBatchRefused,
  decide,
  type DecideOptions,
  type DecideResult,
} from "./approvals.js";
import { getClient, resetClient } from "./client.js";
import { createControlPool, type ControlPool } from "./control-pool.js";
import { defineFlow, type Flow } from "./define-flow.js";
import { runsStart } from "./runs.js";

let database: TestDatabase;
let control: ControlPool;
let client: DBOSClient;
let flow: Flow<{ n: number }, void>;

/** Never dispatched: no worker launches in this file, so the body is only here to be named. */
function decideFlow(): Flow<{ n: number }, void> {
  return defineFlow<{ n: number }, void>("decideFlow", () => Promise.resolve(), { queue: "llm" });
}

async function query<R extends Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<R[]> {
  const { rows } = await control.pool.query<R>(sql, values);
  return rows;
}

async function startRun(runId: string): Promise<void> {
  await runsStart(control.pool, client, flow, { n: 1 }, { runId });
  await query("UPDATE hf_run SET status = 'waiting' WHERE run_id = $1", [runId]);
}

/** A pending approval, the shape `waitForApproval` leaves behind before it suspends. */
async function pending(runId: string, key = "send", expiresAt: string | null = null): Promise<number> {
  const rows = await query<{ id: string }>(
    "INSERT INTO hf_approval (run_id, key, workflow_id, type, draft, status, expires_at) " +
      "VALUES ($1, $2, $3, 'send-email', '{\"body\":\"draft\"}'::jsonb, 'pending', $4) RETURNING id",
    [runId, key, runId, expiresAt],
  );
  return Number(rows[0]!.id);
}

async function approval(id: number): Promise<Record<string, unknown> | undefined> {
  return (
    await query(
      "SELECT run_id, status, decided_by, decided_via, decision_key, edited_draft, " +
        "resume_workflow_id FROM hf_approval WHERE id = $1",
      [id],
    )
  )[0];
}

async function run(runId: string): Promise<Record<string, unknown> | undefined> {
  return (
    await query("SELECT status, attempt, current_workflow_id FROM hf_run WHERE run_id = $1", [
      runId,
    ])
  )[0];
}

async function workflow(workflowId: string): Promise<Record<string, unknown> | undefined> {
  return (
    await query("SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1", [workflowId])
  )[0];
}

function decision(options: Partial<DecideOptions> & Pick<DecideOptions, "ids">): Promise<DecideResult> {
  return decide(control.pool, client, {
    decision: "approved",
    via: "web",
    decisionKey: `key-${options.ids.join(",")}`,
    userId: "crystal",
    ...options,
  });
}

function runIdFor(name: string): string {
  return `${name}-${testBuildSha()}`;
}

beforeAll(async () => {
  database = await createTestDatabase();
  control = createControlPool({ connectionString: database.applicationUrl });
  client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
  flow = decideFlow();
  await asRole(database.migratorUrl, async (pg) => {
    await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, '10')");
  });
}, 120_000);

afterAll(async () => {
  await resetClient();
  await control?.end();
  await database?.drop();
});

beforeEach(async () => {
  await query("DELETE FROM hf_approval");
  await query("DELETE FROM hf_audit");
  await query("DELETE FROM hf_run");
});

describe("approvals.decide", () => {
  it("writes the decision, bumps the run and enqueues its resume workflow in one transaction", async () => {
    const runId = runIdFor("decide");
    await startRun(runId);
    const id = await pending(runId);

    const result = await decision({ ids: [id] });

    expect(result).toMatchObject({
      replayed: false,
      decided: [
        {
          approvalId: id,
          runId,
          key: "send",
          status: "approved",
          resumeWorkflowId: `${runId}:2`,
        },
      ],
      reattempted: [{ runId, attempt: 2, workflowId: `${runId}:2` }],
    });
    expect(await approval(id)).toMatchObject({
      status: "approved",
      decided_by: "crystal",
      decided_via: "web",
      resume_workflow_id: `${runId}:2`,
    });
    expect(await run(runId)).toMatchObject({
      status: "running",
      attempt: 2,
      current_workflow_id: `${runId}:2`,
    });
    // The decision and the workflow that carries it back to the flow are one commit.
    expect(await workflow(`${runId}:2`)).toMatchObject({ status: "ENQUEUED" });
  });

  it("records who decided it and how in hf_audit", async () => {
    const runId = runIdFor("audit");
    await startRun(runId);
    const id = await pending(runId);

    await decision({ ids: [id] });

    expect(await query("SELECT actor_id, action, target_type, target_id FROM hf_audit")).toEqual([
      {
        actor_id: "crystal",
        action: "approval.approved",
        target_type: "hf_approval",
        target_id: String(id),
      },
    ]);
  });

  it("stores an edited draft against the row it belongs to", async () => {
    const runId = runIdFor("edited");
    await startRun(runId);
    const id = await pending(runId);

    await decision({ ids: [id], edits: { [id]: { body: "crystal's words" } } });

    expect(await approval(id)).toMatchObject({ edited_draft: { body: "crystal's words" } });
  });

  it("bumps each run once for a batch spanning two of them", async () => {
    const first = runIdFor("batch-a");
    const second = runIdFor("batch-b");
    await startRun(first);
    await startRun(second);
    const ids = [await pending(first), await pending(second)];

    const result = await decision({ ids });

    expect(result.reattempted).toEqual([
      { runId: [first, second].sort()[0]!, attempt: 2, workflowId: `${[first, second].sort()[0]!}:2` },
      { runId: [first, second].sort()[1]!, attempt: 2, workflowId: `${[first, second].sort()[1]!}:2` },
    ]);
    expect(await run(first)).toMatchObject({ attempt: 2 });
    expect(await run(second)).toMatchObject({ attempt: 2 });
  });

  it("returns the earlier result and writes nothing when the decisionKey replays", async () => {
    const runId = runIdFor("replay");
    await startRun(runId);
    const id = await pending(runId);

    const first = await decision({ ids: [id] });
    const second = await decision({ ids: [id] });

    expect(second).toMatchObject({
      replayed: true,
      decided: [{ approvalId: id, runId, status: "approved", resumeWorkflowId: `${runId}:2` }],
      reattempted: first.reattempted,
    });
    // A second bump would have stranded the attempt the first one enqueued.
    expect(await run(runId)).toMatchObject({ attempt: 2 });
    expect(await query("SELECT id FROM hf_audit")).toHaveLength(1);
  });

  it("refuses the whole batch, writing nothing, when one row is not pending", async () => {
    const runId = runIdFor("mixed");
    const other = runIdFor("mixed-other");
    await startRun(runId);
    await startRun(other);
    const decided = await pending(runId);
    const stillPending = await pending(other);
    await decision({ ids: [decided] });

    await expect(
      decide(control.pool, client, {
        ids: [decided, stillPending],
        decision: "approved",
        via: "web",
        decisionKey: "a-second-batch",
      }),
    ).rejects.toBeInstanceOf(ApprovalBatchRefused);

    expect(await approval(stillPending)).toMatchObject({ status: "pending" });
    expect(await run(other)).toMatchObject({ attempt: 1 });
  });

  it("refuses an id with no row at all", async () => {
    await expect(decision({ ids: [987_654] })).rejects.toThrow(/has no hf_approval row/);
  });

  it("is refused from inside a run before it touches the database", async () => {
    const inWorkflow = vi.spyOn(DBOS, "isWithinWorkflow").mockReturnValue(true);
    try {
      await expect(decision({ ids: [1] })).rejects.toBeInstanceOf(ControlPlaneInWorkflow);
    } finally {
      inWorkflow.mockRestore();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});
