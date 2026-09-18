import { bumpAttempt, controlPlaneTx } from "@hyperfixation/db";
import {
  assertNoFencingFailure,
  createTestDatabase,
  killAt,
  killWhenParked,
  spawnWorker,
  testBuildSha,
  type SpawnedWorker,
  type TestDatabase,
} from "@hyperfixation/testing";
import { resetClient } from "@hyperfixation/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actionRows,
  approvalRows,
  ledgerProbe,
  ledgerRows,
  providerCalls,
  runRow,
  seedAppState,
  startRun,
  waitForStatus,
  workflowRow,
  type LedgerProbe,
} from "./test-support/ledger-harness.js";
import {
  approvalFlow,
  ACTION_SENT_MARKER,
  APPROVAL_KEY,
} from "./test-support/approval-flow.js";
import {
  DECIDED_MARKER,
  KILLED_AT_COMMIT_EXIT,
} from "./test-support/decide-process.js";

const V1_MODULE = new URL("./test-support/approval-flow-v1-fixture.ts", import.meta.url).pathname;
const DECIDE_MODULE = new URL("./test-support/decide-fixture.ts", import.meta.url).pathname;

const KEYS = ["r0", "r1", "r2", "r3", "r4", "r5"];
const KILL_AT = KEYS[2]!;
const INPUT = { keys: KEYS, estimatedCostUsd: 0.01, costUsd: 0.005 };

function actionSends(output: string): number {
  return output.split("\n").filter((line) => line.includes(ACTION_SENT_MARKER)).length;
}

/**
 * Redeploy case 8, round-2 finding 2: a run that is bumped by `reconcile()` and then bumped
 * again by `decide()`. The second bump is the one the finding broke — computing the next
 * attempt in SQL made it re-use `:2` — so what this case is really about is that the run walks
 * `:2` then `:3` with a workflow row for each.
 */
describe("redeploy case 8 — a reconcile bump, then an approval", () => {
  let database: TestDatabase;
  let probe: LedgerProbe;
  let workerB: SpawnedWorker;

  function decider(control: {
    approvalIds: number[];
    decisionKey: string;
    killBeforeCommit?: boolean;
  }): SpawnedWorker {
    return spawnWorker({
      module: DECIDE_MODULE,
      appName: database.appName,
      databaseUrl: database.applicationUrl,
      control,
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    probe = ledgerProbe(database);
    await seedAppState(database, "100");
  }, 60_000);

  afterAll(async () => {
    await resetClient();
    await workerB?.kill().catch(() => undefined);
    await probe?.close();
    await database?.drop();
  });

  it(
    "walks the run from :2 to :3, one workflow row per bump and one action at the end",
    async () => {
      const flow = approvalFlow();
      const runId = `case8-${testBuildSha()}`;

      const workerA = spawnWorker({
        module: V1_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
        control: { killAt: killAt(KILL_AT, "before-checkpoint") },
      });
      let callsA: number;
      try {
        await workerA.ready();
        await startRun(probe, flow, INPUT, runId);
        await killWhenParked(workerA, killAt(KILL_AT, "before-checkpoint"), 120_000);
        assertNoFencingFailure(workerA);
        callsA = providerCalls(workerA.output());
      } finally {
        await workerA.kill().catch(() => undefined);
      }
      expect(callsA).toBe(KEYS.indexOf(KILL_AT) + 1);

      workerB = spawnWorker({
        module: V1_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
      });
      await workerB.ready();
      // Worker B's boot pass cancels the attempt A left under a dead version and bumps.
      expect(await runRow(probe, runId)).toMatchObject({
        attempt: 2,
        current_workflow_id: `${runId}:2`,
      });

      await waitForStatus(probe, runId, "waiting", 120_000);
      expect(await workflowRow(probe, `${runId}:2`)).toMatchObject({ status: "SUCCESS" });
      const [approval] = await approvalRows(probe, runId);
      const approvalId = Number(approval!.id);
      const decisionKey = `web-${runId}`;

      // The deciding process dies with everything written and nothing committed.
      const killed = decider({ approvalIds: [approvalId], decisionKey, killBeforeCommit: true });
      expect((await killed.exited).code).toBe(KILLED_AT_COMMIT_EXIT);
      expect(await runRow(probe, runId)).toMatchObject({ status: "waiting", attempt: 2 });
      expect(await workflowRow(probe, `${runId}:3`)).toBeUndefined();
      expect(await approvalRows(probe, runId)).toMatchObject([{ status: "pending" }]);

      const retried = decider({ approvalIds: [approvalId], decisionKey });
      try {
        await retried.waitFor(DECIDED_MARKER, 60_000);
      } finally {
        await retried.kill().catch(() => undefined);
      }

      // The approved row and the workflow that resumes the run were written by one transaction.
      expect(await approvalRows(probe, runId)).toMatchObject([
        { status: "approved", resume_workflow_id: `${runId}:3` },
      ]);
      expect(await workflowRow(probe, `${runId}:3`)).toBeDefined();
      expect(await runRow(probe, runId)).toMatchObject({
        attempt: 3,
        current_workflow_id: `${runId}:3`,
      });

      await waitForStatus(probe, runId, "done", 120_000);
      assertNoFencingFailure(workerB);
      // Attempt 2 re-ran the key A was killed on; attempt 3 replayed every row from the ledger.
      expect(callsA + providerCalls(workerB.output())).toBe(KEYS.length + 1);
      const rows = await ledgerRows(probe, runId);
      expect(rows.filter((row) => row.status !== "ok")).toEqual([]);
      expect(rows.filter((row) => row.possible_double_charge).map((row) => row.key)).toEqual([
        KILL_AT,
      ]);
      expect(await actionRows(probe, runId)).toMatchObject([
        { key: APPROVAL_KEY, status: "ok", idempotency_key: `${runId}:${APPROVAL_KEY}` },
      ]);
      expect(actionSends(workerB.output())).toBe(1);
    },
    300_000,
  );

  it("gives two sequential bumps of one row :2 and then :3", async () => {
    const runId = `case8-bumps-${testBuildSha()}`;
    await probe.pool.query(
      "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
        "VALUES ($1, 'approvalFlow', '{}', 'running', 1, $1)",
      [runId],
    );

    const first = await controlPlaneTx(probe.pool, { operation: "test-bump" }, (client) =>
      bumpAttempt(client, runId),
    );
    const second = await controlPlaneTx(probe.pool, { operation: "test-bump" }, (client) =>
      bumpAttempt(client, runId),
    );

    // Round-2 finding 2: `attempt = attempt + 1` in SQL made the second of these `:2` as well.
    expect([first.workflowId, second.workflowId]).toEqual([`${runId}:2`, `${runId}:3`]);
  });
});
