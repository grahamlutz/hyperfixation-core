import {
  assertNoFencingFailure,
  createTestDatabase,
  spawnWorker,
  testBuildSha,
  waitForWorkflowStatus,
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
  CLASSIFY_KEY,
} from "./test-support/approval-flow.js";
import {
  DECIDED_MARKER,
  KILLED_AT_COMMIT_EXIT,
  KILLED_AT_COMMIT_MARKER,
} from "./test-support/decide-process.js";

const V1_MODULE = new URL("./test-support/approval-flow-v1-fixture.ts", import.meta.url).pathname;
const V2_MODULE = new URL("./test-support/approval-flow-v2-fixture.ts", import.meta.url).pathname;
const DECIDE_MODULE = new URL("./test-support/decide-fixture.ts", import.meta.url).pathname;

const DRAFT_KEY = "draft";
const COST_USD = 0.005;
const INPUT = { keys: [DRAFT_KEY], estimatedCostUsd: 0.01, costUsd: COST_USD };

/** One line per dispatch that reached the channel, whichever worker printed it. */
function actionSends(output: string): number {
  return output.split("\n").filter((line) => line.includes(ACTION_SENT_MARKER)).length;
}

/**
 * Redeploy case 1. A run waits at an approval across a redeploy that changed the code around
 * it: the workflow ended at the gate rather than parking in it, so there is nothing for the
 * new SHA to be incompatible with, and the decision starts a fresh attempt of the new module.
 */
describe("redeploy case 1 — an approval across a redeploy with changed code", () => {
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
    "ends attempt 1 waiting, then finishes on attempt 2 with only the new key charged",
    async () => {
      const flow = approvalFlow();
      const runId = `case1-${testBuildSha()}`;

      const workerA = spawnWorker({
        module: V1_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
      });
      let callsA: number;
      let sendsA: number;
      try {
        await workerA.ready();
        await startRun(probe, flow, INPUT, runId);
        await waitForStatus(probe, runId, "waiting", 120_000);

        // The attempt ended cleanly at the gate: SUCCESS, not a workflow held open. Polled,
        // because the `waiting` write above is committed from inside the body — DBOS marks the
        // attempt SUCCESS only once that body returns.
        await waitForWorkflowStatus(probe.pool, runId, "SUCCESS", { timeoutMs: 30_000 });
        expect(await ledgerRows(probe, runId)).toMatchObject([{ key: DRAFT_KEY, status: "ok" }]);
        expect(await approvalRows(probe, runId)).toMatchObject([
          { key: APPROVAL_KEY, status: "pending" },
        ]);
        expect(await actionRows(probe, runId)).toEqual([]);
        assertNoFencingFailure(workerA);
        callsA = providerCalls(workerA.output());
        sendsA = actionSends(workerA.output());
      } finally {
        await workerA.kill().catch(() => undefined);
      }
      expect([callsA, sendsA]).toEqual([1, 0]);

      workerB = spawnWorker({
        module: V2_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
      });
      await workerB.ready();
      // A `waiting` run is nobody's to move: reconcile() touches `running` and `paused` ones.
      expect(await runRow(probe, runId)).toMatchObject({ status: "waiting", attempt: 1 });

      const [approval] = await approvalRows(probe, runId);
      const decide = decider({
        approvalIds: [Number(approval!.id)],
        decisionKey: `web-${runId}`,
      });
      try {
        await decide.waitFor(DECIDED_MARKER, 60_000);
      } finally {
        await decide.kill().catch(() => undefined);
      }

      await waitForStatus(probe, runId, "done", 120_000);
      expect(await runRow(probe, runId)).toMatchObject({
        attempt: 2,
        current_workflow_id: `${runId}:2`,
        status: "done",
      });
      assertNoFencingFailure(workerB);
      // Attempt 2 runs v2 from the top: `draft` replays from its ledger row and only the key
      // the new module added reaches the provider.
      expect(providerCalls(workerB.output())).toBe(1);
      expect(await ledgerRows(probe, runId)).toMatchObject([
        { key: CLASSIFY_KEY, status: "ok" },
        { key: DRAFT_KEY, status: "ok", possible_double_charge: false },
      ]);
      expect(await actionRows(probe, runId)).toMatchObject([
        { key: APPROVAL_KEY, status: "ok", idempotency_key: `${runId}:${APPROVAL_KEY}` },
      ]);
      expect(actionSends(workerB.output())).toBe(1);
      expect(await approvalRows(probe, runId)).toMatchObject([
        { status: "approved", decided_by: "crystal", resume_workflow_id: `${runId}:2` },
      ]);
    },
    300_000,
  );

  it(
    "leaves nothing behind when the deciding process dies before its COMMIT",
    async () => {
      const runId = `case1-killed-${testBuildSha()}`;
      await startRun(probe, approvalFlow(), INPUT, runId);
      await waitForStatus(probe, runId, "waiting", 120_000);
      const [approval] = await approvalRows(probe, runId);
      const approvalId = Number(approval!.id);
      const decisionKey = `web-${runId}`;

      const killed = decider({ approvalIds: [approvalId], decisionKey, killBeforeCommit: true });
      const exit = await killed.exited;
      expect(killed.output()).toContain(KILLED_AT_COMMIT_MARKER);
      expect(exit.code).toBe(KILLED_AT_COMMIT_EXIT);

      // The decision, the bump and the enqueue are one transaction: none of them survived.
      expect(await runRow(probe, runId)).toMatchObject({ status: "waiting", attempt: 1 });
      expect(await workflowRow(probe, `${runId}:2`)).toBeUndefined();
      expect(await approvalRows(probe, runId)).toMatchObject([
        { status: "pending", decision_key: null },
      ]);

      const retried = decider({ approvalIds: [approvalId], decisionKey });
      try {
        await retried.waitFor(DECIDED_MARKER, 60_000);
      } finally {
        await retried.kill().catch(() => undefined);
      }

      await waitForStatus(probe, runId, "done", 120_000);
      expect(await approvalRows(probe, runId)).toMatchObject([
        { status: "approved", decision_key: decisionKey },
      ]);
      expect(await actionRows(probe, runId)).toMatchObject([
        { key: APPROVAL_KEY, status: "ok" },
      ]);
    },
    300_000,
  );
});
