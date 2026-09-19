import { DBOS, type DBOSClient } from "@dbos-inc/dbos-sdk";
import { checkE002, ControlPlaneInWorkflow } from "@hyperfixation/db";
import { asRole, createTestDatabase, testBuildSha, type TestDatabase } from "@hyperfixation/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
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
async function pending(
  runId: string,
  key = "send",
  expiresAt: string | null = null,
  assigneeId: string | null = null,
): Promise<number> {
  const rows = await query<{ id: string }>(
    "INSERT INTO hf_approval (run_id, key, workflow_id, type, draft, status, expires_at, " +
      "assignee_id) VALUES ($1, $2, $3, 'send-email', '{\"body\":\"draft\"}'::jsonb, 'pending', " +
      "$4, $5) RETURNING id",
    [runId, key, runId, expiresAt, assigneeId],
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

/** What the app's registry would hand `decide()`: `send-email` is the only type here. */
const DRAFT_SCHEMA = z.object({ body: z.string() });
const schemaFor = (type: string): z.ZodType | undefined =>
  type === "send-email" ? DRAFT_SCHEMA : undefined;

function decision(options: Partial<DecideOptions> & Pick<DecideOptions, "ids">): Promise<DecideResult> {
  return decide(control.pool, client, {
    decision: "approved",
    via: "web",
    decisionKey: `key-${options.ids.join(",")}`,
    userId: "crystal",
    schemaFor,
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
  await query("DELETE FROM hf_activity");
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

describe("approvals.decide — validating the edited drafts", () => {
  it("writes what the schema parsed, not what the caller sent", async () => {
    const runId = runIdFor("parsed");
    await startRun(runId);
    const id = await pending(runId);

    await decision({ ids: [id], edits: { [id]: { body: "kept", smuggled: "dropped" } } });

    expect(await approval(id)).toMatchObject({ edited_draft: { body: "kept" } });
  });

  it("refuses the whole batch when one edit does not match its type's schema", async () => {
    const first = runIdFor("schema-a");
    const second = runIdFor("schema-b");
    await startRun(first);
    await startRun(second);
    const good = await pending(first);
    const bad = await pending(second);

    await expect(
      decision({ ids: [good, bad], edits: { [good]: { body: "fine" }, [bad]: { body: 7 } } }),
    ).rejects.toThrow(new RegExp(`${bad} has an edit that does not match schema for type send-email`));

    expect(await approval(good)).toMatchObject({ status: "pending", edited_draft: null });
    expect(await approval(bad)).toMatchObject({ status: "pending" });
    expect(await run(first)).toMatchObject({ attempt: 1 });
    expect(await run(second)).toMatchObject({ attempt: 1 });
  });

  it("refuses an edit on a type no schema is registered for", async () => {
    const runId = runIdFor("no-schema");
    await startRun(runId);
    const id = await pending(runId);
    await query("UPDATE hf_approval SET type = 'send-letter' WHERE id = $1", [id]);

    await expect(decision({ ids: [id], edits: { [id]: { body: "x" } } })).rejects.toThrow(
      /has an edit but type send-letter has no registered schema/,
    );
    expect(await approval(id)).toMatchObject({ status: "pending" });
  });

  it("refuses edits with no schemaFor before it touches the database", async () => {
    const connect = vi.spyOn(control.pool, "connect");

    await expect(
      decide(control.pool, client, {
        ids: [1],
        decision: "approved",
        via: "web",
        decisionKey: "no-lookup",
        edits: { 1: { body: "x" } },
      }),
    ).rejects.toBeInstanceOf(TypeError);

    expect(connect).not.toHaveBeenCalled();
  });

  /**
   * Adversary target (c). The lookup runs inside `controlPlaneTx`'s `work`, and nothing in
   * `decideOnce` catches — so a throw from it has to leave through `ROLLBACK`, not a half-write.
   */
  it("rolls the whole transaction back when schemaFor itself throws", async () => {
    const runId = runIdFor("throwing-lookup");
    await startRun(runId);
    const id = await pending(runId);
    const boom = new Error("the registry exploded");

    await expect(
      decision({
        ids: [id],
        edits: { [id]: { body: "x" } },
        schemaFor: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);

    expect(await approval(id)).toMatchObject({ status: "pending", decision_key: null });
    expect(await run(runId)).toMatchObject({ attempt: 1 });
    expect(await workflow(`${runId}:2`)).toBeUndefined();
    expect(await query("SELECT id FROM hf_audit")).toHaveLength(0);
    expect(await query("SELECT id FROM hf_activity")).toHaveLength(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

describe("approvals.decide — the assignee rule", () => {
  it("refuses a row assigned to someone else", async () => {
    const runId = runIdFor("assigned");
    await startRun(runId);
    const id = await pending(runId, "send", null, "dana");

    await expect(decision({ ids: [id] })).rejects.toThrow(
      new RegExp(`${id} is assigned to dana`),
    );
    expect(await approval(id)).toMatchObject({ status: "pending" });
    expect(await run(runId)).toMatchObject({ attempt: 1 });
  });

  it("lets the assignee decide their own row", async () => {
    const runId = runIdFor("assignee-self");
    await startRun(runId);
    const id = await pending(runId, "send", null, "crystal");

    await decision({ ids: [id] });

    expect(await approval(id)).toMatchObject({ status: "approved", decided_by: "crystal" });
  });

  it("lets an admin decide a row assigned to someone else", async () => {
    const runId = runIdFor("assignee-admin");
    await startRun(runId);
    const id = await pending(runId, "send", null, "dana");

    await decision({ ids: [id], admin: true, via: "admin" });

    expect(await approval(id)).toMatchObject({ status: "approved", decided_via: "admin" });
  });

  it("still refuses via 'admin' without the admin flag — the flag is the authority", async () => {
    const runId = runIdFor("admin-via-only");
    await startRun(runId);
    const id = await pending(runId, "send", null, "dana");

    await expect(decision({ ids: [id], via: "admin" })).rejects.toBeInstanceOf(
      ApprovalBatchRefused,
    );
  });

  it("exempts archive and sweep, which carry no human decider", async () => {
    const archived = runIdFor("assignee-archive");
    const swept = runIdFor("assignee-sweep");
    await startRun(archived);
    await startRun(swept);
    const byArchive = await pending(archived, "send", null, "dana");
    const bySweep = await pending(swept, "send", null, "dana");

    await decision({ ids: [byArchive], decision: "cancelled", via: "archive", userId: null });
    await decision({ ids: [bySweep], decision: "expired", via: "sweep", userId: null });

    expect(await approval(byArchive)).toMatchObject({ status: "cancelled" });
    expect(await approval(bySweep)).toMatchObject({ status: "expired" });
  });
});

describe("approvals.decide — hf_activity", () => {
  it("writes one row per decided approval, against the record the approval names", async () => {
    const runId = runIdFor("activity");
    await startRun(runId);
    const id = await pending(runId);
    await query("UPDATE hf_approval SET record_type = 'business', record_id = '42' WHERE id = $1", [
      id,
    ]);

    const result = await decision({ ids: [id] });

    expect(
      await query("SELECT record_type, record_id, kind, actor_id, run_id, meta FROM hf_activity"),
    ).toEqual([
      {
        record_type: "business",
        record_id: "42",
        kind: "approval.approved",
        actor_id: "crystal",
        // Reading 4: a decision is a web-side write, so the timeline groups it under "manual".
        run_id: null,
        meta: {
          runId,
          key: "send",
          via: "web",
          decisionKey: `key-${id}`,
          batchId: null,
          resumeWorkflowId: result.decided[0]!.resumeWorkflowId,
        },
      },
    ]);
  });

  it("leaves the record columns null when the approval names no record, so E002 passes", async () => {
    const runId = runIdFor("activity-no-record");
    await startRun(runId);
    const id = await pending(runId);

    await decision({ ids: [id] });

    // A stand-in such as `'hf_approval'` would fail E002 at the next worker boot; the audit
    // row's `target_id` is where the approval id is already recorded.
    expect(await query("SELECT record_type, record_id FROM hf_activity")).toEqual([
      { record_type: null, record_id: null },
    ]);
    await expect(checkE002(control.pool, [])).resolves.toBeUndefined();
  });

  it("writes nothing on a replay", async () => {
    const runId = runIdFor("activity-replay");
    await startRun(runId);
    const id = await pending(runId);

    await decision({ ids: [id] });
    await decision({ ids: [id] });

    expect(await query("SELECT id FROM hf_activity")).toHaveLength(1);
  });

  it("is fatal: a failed insert leaves the approval pending and a retry succeeds", async () => {
    const runId = runIdFor("activity-fatal");
    await startRun(runId);
    const id = await pending(runId);

    await asRole(database.migratorUrl, async (pg) => {
      await pg.query(
        "CREATE FUNCTION refuse_activity() RETURNS trigger AS $$ BEGIN " +
          "RAISE EXCEPTION 'hf_activity is closed'; END; $$ LANGUAGE plpgsql",
      );
      await pg.query(
        "CREATE TRIGGER refuse_activity BEFORE INSERT ON hf_activity " +
          "FOR EACH ROW EXECUTE FUNCTION refuse_activity()",
      );
    });

    await expect(decision({ ids: [id] })).rejects.toThrow(/hf_activity is closed/);

    expect(await approval(id)).toMatchObject({ status: "pending", decision_key: null });
    expect(await run(runId)).toMatchObject({ attempt: 1 });
    expect(await workflow(`${runId}:2`)).toBeUndefined();
    expect(await query("SELECT id FROM hf_audit")).toHaveLength(0);

    await asRole(database.migratorUrl, async (pg) => {
      await pg.query("DROP TRIGGER refuse_activity ON hf_activity");
      await pg.query("DROP FUNCTION refuse_activity()");
    });

    await decision({ ids: [id] });

    expect(await approval(id)).toMatchObject({ status: "approved", decision_key: `key-${id}` });
    expect(await query("SELECT id FROM hf_activity")).toHaveLength(1);
  });
});

describe("approvals.decide — batch_id", () => {
  it("stamps one id on every row of a multi-row batch and returns it", async () => {
    const first = runIdFor("batch-id-a");
    const second = runIdFor("batch-id-b");
    await startRun(first);
    await startRun(second);
    const ids = [await pending(first), await pending(second)];

    const result = await decision({ ids });

    expect(result.batchId).toEqual(expect.any(String));
    const rows = await query<{ batch_id: string | null }>(
      "SELECT batch_id FROM hf_approval ORDER BY id",
    );
    expect(rows).toEqual([{ batch_id: result.batchId }, { batch_id: result.batchId }]);

    // A replay reads the stored id back rather than minting a second one.
    expect((await decision({ ids })).batchId).toBe(result.batchId);
  });

  it("leaves batch_id null for a batch of one", async () => {
    const runId = runIdFor("batch-id-single");
    await startRun(runId);
    const id = await pending(runId);

    expect((await decision({ ids: [id] })).batchId).toBeNull();
    expect(await query("SELECT batch_id FROM hf_approval")).toEqual([{ batch_id: null }]);
  });
});
