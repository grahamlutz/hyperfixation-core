import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  assertNoFencingFailure,
  asRole,
  createTestDatabase,
  killAt,
  killWhenParked,
  spawnWorker,
  testBuildSha,
  type SpawnedWorker,
  type TestDatabase,
} from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";
import { decide } from "./approvals.js";
import { getClient, resetClient } from "./client.js";
import { createControlPool, type ControlPool } from "./control-pool.js";
import { runsStart } from "./runs.js";
import {
  approvalFlow,
  APPROVAL_KEY,
  DECISION_MARKER,
  NOTIFY_MARKER,
  NOTIFY_PARK_KEY,
} from "./test-support/approval-flow.js";

const APPROVAL_MODULE = new URL("./test-support/approval-flow-fixture.ts", import.meta.url)
  .pathname;

/** Reassigned by each describe's `beforeAll`, which the helpers below read through. */
let database: TestDatabase;
let control: ControlPool;
let client: DBOSClient;

async function query<R extends Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<R[]> {
  const { rows } = await control.pool.query<R>(sql, values);
  return rows;
}

/** The counter table the fixture's `before`/`after` steps upsert into, plus the pause flag. */
async function seed(): Promise<void> {
  await asRole(database.migratorUrl, async (pg) => {
    await pg.query(
      "CREATE TABLE test_counter (run_id text, step_key text, count int NOT NULL, " +
        "PRIMARY KEY (run_id, step_key))",
    );
    await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, '10')");
  });
}

async function waitForStatus(runId: string, status: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await query<{ status: string }>("SELECT status FROM hf_run WHERE run_id = $1", [
      runId,
    ]);
    if (rows[0]?.status === status) return;
    if (Date.now() > deadline) {
      throw new Error(`hf_run ${runId} never reached ${status} (still ${rows[0]?.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function counter(runId: string, key: string): Promise<number | undefined> {
  const rows = await query<{ count: number }>(
    "SELECT count FROM test_counter WHERE run_id = $1 AND step_key = $2",
    [runId, key],
  );
  return rows[0]?.count;
}

interface ApprovalRow extends Record<string, unknown> {
  id: string;
  key: string;
  status: string;
  notified_at: Date | null;
  resume_workflow_id: string | null;
}

async function approvalsOf(runId: string): Promise<ApprovalRow[]> {
  return query<ApprovalRow>(
    "SELECT id, key, status, notified_at, resume_workflow_id FROM hf_approval " +
      "WHERE run_id = $1 ORDER BY id",
    [runId],
  );
}

interface WorkflowRow extends Record<string, unknown> {
  workflow_uuid: string;
  application_version: string | null;
}

async function workflowsOf(runId: string): Promise<WorkflowRow[]> {
  return query<WorkflowRow>(
    "SELECT workflow_uuid, application_version FROM dbos.workflow_status " +
      "WHERE workflow_uuid LIKE $1 ORDER BY workflow_uuid",
    [`${runId}%`],
  );
}

function approve(id: number, runId: string): Promise<unknown> {
  return decide(control.pool, client, {
    ids: [id],
    decision: "approved",
    via: "web",
    userId: "crystal",
    decisionKey: `web-${runId}`,
  });
}

describe("waitForApproval — the gate, the suspend, and the attempt decide() enqueues", () => {
  let worker: SpawnedWorker;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed();

    worker = spawnWorker({
      module: APPROVAL_MODULE,
      appName: database.appName,
      databaseUrl: database.applicationUrl,
    });
    await worker.ready();

    control = createControlPool({ connectionString: database.applicationUrl });
    client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
  }, 120_000);

  afterAll(async () => {
    await resetClient();
    await control?.end();
    await worker?.kill();
    await database?.drop();
  });

  it(
    "ends the attempt waiting on a pending row, then carries the decision into attempt 2",
    async () => {
      const runId = `approval-${testBuildSha()}`;
      await runsStart(control.pool, client, approvalFlow, {}, { runId });

      await waitForStatus(runId, "waiting");
      const [pending] = await approvalsOf(runId);
      expect(pending).toMatchObject({ status: "pending" });
      expect(pending!.notified_at).not.toBeNull();
      expect(worker.output()).toContain(`${NOTIFY_MARKER} ${APPROVAL_KEY}`);
      // The workflow ended rather than parking in it: that is what makes the wait survive a
      // redeploy, and `waiting` is only reachable through `Suspend`.
      const [attempt1] = await query<{ status: string }>(
        "SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1",
        [runId],
      );
      expect(attempt1).toMatchObject({ status: "SUCCESS" });
      expect(await counter(runId, "after")).toBeUndefined();

      await decide(control.pool, client, {
        ids: [Number(pending!.id)],
        decision: "approved",
        via: "web",
        userId: "crystal",
        decisionKey: `web-${runId}`,
        edits: { [Number(pending!.id)]: { body: "crystal's words" } },
        schemaFor: () => z.object({ body: z.string() }),
      });

      await waitForStatus(runId, "done");
      expect(worker.output()).toContain(
        `${DECISION_MARKER} ${JSON.stringify({
          runId,
          key: APPROVAL_KEY,
          status: "approved",
          draft: { body: "crystal's words" },
        })}`,
      );
      expect(await counter(runId, "after")).toBe(1);
      // Attempt 2 runs the flow from the top, so everything before the gate runs again: the
      // documented cost of ending the workflow instead of parking inside it.
      expect(await counter(runId, "before")).toBe(2);
      expect(await query("SELECT attempt FROM hf_run WHERE run_id = $1", [runId])).toEqual([
        { attempt: 2 },
      ]);
    },
    180_000,
  );

  /** Adversary 3b: there is no topic and no message, so nothing can be delivered to the wrong gate. */
  it(
    "resumes with the decided row's own decision and leaves the run's other approval pending",
    async () => {
      const runId = `approval-two-${testBuildSha()}`;
      await runsStart(control.pool, client, approvalFlow, { extraKey: "other" }, { runId });

      await waitForStatus(runId, "waiting");
      const rows = await approvalsOf(runId);
      expect(rows.map((row) => [row.key, row.status])).toEqual([
        ["other", "pending"],
        [APPROVAL_KEY, "pending"],
      ]);
      const gate = rows.find((row) => row.key === APPROVAL_KEY)!;

      await approve(Number(gate.id), runId);

      await waitForStatus(runId, "done");
      expect(worker.output()).toContain(
        `${DECISION_MARKER} ${JSON.stringify({
          runId,
          key: APPROVAL_KEY,
          status: "approved",
          draft: { body: "draft" },
        })}`,
      );
      expect(await approvalsOf(runId)).toMatchObject([
        { key: "other", status: "pending", resume_workflow_id: null },
        { key: APPROVAL_KEY, status: "approved", resume_workflow_id: `${runId}:2` },
      ]);
    },
    180_000,
  );

  /** Adversary 3c: no core table has an FK to a DBOS row, and the gate's state is `hf_approval`'s. */
  it(
    "loses nothing when the run's DBOS workflow rows are deleted before the decision",
    async () => {
      const runId = `approval-deleted-${testBuildSha()}`;
      await runsStart(control.pool, client, approvalFlow, {}, { runId });

      await waitForStatus(runId, "waiting");
      const [pending] = await approvalsOf(runId);

      await client.deleteWorkflows([runId], true);
      expect(await workflowsOf(runId)).toEqual([]);

      await approve(Number(pending!.id), runId);

      await waitForStatus(runId, "done");
      expect(await counter(runId, "after")).toBe(1);
      expect(await approvalsOf(runId)).toMatchObject([
        { status: "approved", resume_workflow_id: `${runId}:2` },
      ]);
    },
    180_000,
  );
});

describe("waitForApproval — a crash inside the gate, and the version it resumes under", () => {
  let workerA: SpawnedWorker;
  let workerB: SpawnedWorker;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed();
    control = createControlPool({ connectionString: database.applicationUrl });
    client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
  }, 120_000);

  afterAll(async () => {
    await resetClient();
    await control?.end();
    await workerA?.kill().catch(() => undefined);
    await workerB?.kill().catch(() => undefined);
    await database?.drop();
  });

  it(
    "creates no second row when the gate is re-entered, and resumes under the live version",
    async () => {
      const runId = `approval-crash-${testBuildSha()}`;
      const parked = killAt(NOTIFY_PARK_KEY, "before-checkpoint");

      workerA = spawnWorker({
        module: APPROVAL_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
        control: { killAt: parked },
      });
      await workerA.ready();
      await runsStart(control.pool, client, approvalFlow, {}, { runId });

      // Killed inside `waitForApproval` with the row committed and `notified_at` still NULL —
      // the state in which a re-entry without `ON CONFLICT DO NOTHING` would open a second row.
      await killWhenParked(workerA, parked, 120_000);
      assertNoFencingFailure(workerA);
      const [first] = await approvalsOf(runId);
      expect(first).toMatchObject({ key: APPROVAL_KEY, status: "pending" });
      expect(first!.notified_at).toBeNull();

      workerB = spawnWorker({
        module: APPROVAL_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
      });
      await workerB.ready();
      await waitForStatus(runId, "waiting", 120_000);

      // Attempt 2 is a workflow id of its own, so the gate's steps really did run again.
      const rows = await approvalsOf(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: first!.id, status: "pending" });
      expect(rows[0]!.notified_at).not.toBeNull();
      expect(await counter(runId, "before")).toBe(2);

      await approve(Number(first!.id), runId);
      await waitForStatus(runId, "done", 120_000);
      assertNoFencingFailure(workerB);
      expect(await approvalsOf(runId)).toHaveLength(1);

      // The resumed attempts ran under whichever worker was live, never under A's dead version.
      const workflows = await workflowsOf(runId);
      expect(workflows.map((row) => [row.workflow_uuid, row.application_version])).toEqual([
        [runId, workerA.version],
        [`${runId}:2`, workerB.version],
        [`${runId}:3`, workerB.version],
      ]);
    },
    300_000,
  );
});
