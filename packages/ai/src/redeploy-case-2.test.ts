import {
  assertNoFencingFailure,
  createTestDatabase,
  killAt,
  killWhenParked,
  spawnWorker,
  testBuildSha,
  type TestDatabase,
} from "@hyperfixation/testing";
import { resetClient } from "@hyperfixation/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  budgetPeriod,
  currentPeriod,
  derivedReservation,
  ledgerProbe,
  ledgerRows,
  providerCalls,
  runRow,
  seedAppState,
  startRun,
  waitForStatus,
  type LedgerProbe,
} from "./test-support/ledger-harness.js";
import { llmFlow } from "./test-support/llm-flow.js";

const V1_MODULE = new URL("./test-support/llm-flow-v1-fixture.ts", import.meta.url).pathname;
const V2_MODULE = new URL("./test-support/llm-flow-v2-fixture.ts", import.meta.url).pathname;

const KEYS = Array.from({ length: 24 }, (_, index) => `r${String(index).padStart(2, "0")}`);
const KILL_AT = KEYS[12]!;
const COST_USD = 0.005;

/**
 * Redeploy case 2, the adversary's round-1 finding 2. Worker A dies with the provider's answer
 * in hand and nothing checkpointed; worker B picks the run up under a new SHA whose module has
 * an extra step, so DBOS has no checkpoint to replay and every key goes through the ledger.
 *
 * `reconcile()` lands in chunk 11, so its bump-and-enqueue is driven by hand here. That is the
 * whole of what this case needs from it: the ledger's own correctness never depends on a row
 * being marked `abandoned`, only on whose attempt the row names.
 */
describe("redeploy case 2 — a loop killed before a checkpoint, relaunched under a new SHA", () => {
  let database: TestDatabase;
  let probe: LedgerProbe;

  beforeAll(async () => {
    database = await createTestDatabase();
    probe = ledgerProbe(database);
    await seedAppState(database, "100");
  }, 60_000);

  afterAll(async () => {
    await resetClient();
    await probe?.close();
    await database?.drop();
  });

  it(
    "finishes every key with exactly one extra provider call, flagged on the one row",
    async () => {
      const flow = llmFlow();
      const runId = `case2-${testBuildSha()}`;
      const input = { keys: KEYS, estimatedCostUsd: 0.01, costUsd: COST_USD };

      const workerA = spawnWorker({
        module: V1_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
        control: { killAt: killAt(KILL_AT, "before-checkpoint") },
      });
      let callsA: number;
      try {
        await workerA.ready();
        await startRun(probe, flow, input, runId);
        await killWhenParked(workerA, killAt(KILL_AT, "before-checkpoint"), 60_000);
        assertNoFencingFailure(workerA);
        callsA = providerCalls(workerA.output());
      } finally {
        await workerA.kill().catch(() => undefined);
      }
      // The provider answered for `KILL_AT` and the row is `started`: the one state that costs
      // money twice, and the only one that produces a `possible_double_charge`.
      expect(callsA).toBe(KEYS.indexOf(KILL_AT) + 1);

      const workerB = spawnWorker({
        module: V2_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
      });
      let callsB: number;
      try {
        // No bump by hand any more: since chunk 11, worker B's own boot `reconcile()` cancels
        // the attempt A left under a dead version and enqueues attempt 2 before it is ready.
        await workerB.ready();
        expect(await runRow(probe, runId)).toMatchObject({
          attempt: 2,
          current_workflow_id: `${runId}:2`,
        });
        await waitForStatus(probe, runId, "done", 120_000);
        assertNoFencingFailure(workerB);
        callsB = providerCalls(workerB.output());
        await workerB.shutdown();
      } finally {
        await workerB.kill().catch(() => undefined);
      }

      expect(callsA + callsB).toBe(KEYS.length + 1);

      const rows = await ledgerRows(probe, runId);
      expect(rows.map((row) => row.key)).toEqual([...KEYS].sort());
      expect(rows.filter((row) => row.status !== "ok")).toEqual([]);
      expect(rows.filter((row) => row.possible_double_charge).map((row) => row.key)).toEqual([
        KILL_AT,
      ]);

      const period = await currentPeriod(probe);
      expect(await derivedReservation(probe, period)).toBe("0");
      expect(Number((await budgetPeriod(probe, period))?.spent_usd)).toBeCloseTo(
        KEYS.length * COST_USD,
        6,
      );
      expect(await runRow(probe, runId)).toMatchObject({ status: "done", attempt: 2 });
    },
    300_000,
  );
});
