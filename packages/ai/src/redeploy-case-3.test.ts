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

const KEYS = Array.from({ length: 24 }, (_, index) => `r${String(index).padStart(2, "0")}`);
const KILL_AT = KEYS[11]!;

/**
 * Redeploy case 3. The crash lands *after* the step's checkpoint and the relaunch is at the same
 * SHA, so DBOS's own recovery replays the checkpointed steps and `llm.run` is never called for
 * them — the ledger's replay path is not even reached, and neither is an extra provider call.
 */
describe("redeploy case 3 — same-version crash recovery uses DBOS checkpoints", () => {
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
    "makes exactly one provider call per key across both workers, with nothing flagged",
    async () => {
      const version = testBuildSha();
      const runId = `case3-${version}`;
      const flow = llmFlow();
      const input = { keys: KEYS, estimatedCostUsd: 0.01, costUsd: 0.005 };

      const workerA = spawnWorker({
        module: V1_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
        version,
        control: { killAt: killAt(KILL_AT, "after-checkpoint") },
      });
      let callsA: number;
      try {
        await workerA.ready();
        await startRun(probe, flow, input, runId);
        await killWhenParked(workerA, killAt(KILL_AT, "after-checkpoint"), 60_000);
        assertNoFencingFailure(workerA);
        callsA = providerCalls(workerA.output());
      } finally {
        await workerA.kill().catch(() => undefined);
      }
      expect(callsA).toBe(KEYS.indexOf(KILL_AT) + 1);

      const workerB = spawnWorker({
        module: V1_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
        version,
      });
      let callsB: number;
      try {
        await workerB.ready();
        await waitForStatus(probe, runId, "done", 90_000);
        assertNoFencingFailure(workerB);
        callsB = providerCalls(workerB.output());
        await workerB.shutdown();
      } finally {
        await workerB.kill().catch(() => undefined);
      }

      expect(callsA + callsB).toBe(KEYS.length);

      const rows = await ledgerRows(probe, runId);
      expect(rows.map((row) => row.key)).toEqual([...KEYS].sort());
      expect(rows.filter((row) => row.status !== "ok")).toEqual([]);
      expect(rows.filter((row) => row.possible_double_charge)).toEqual([]);
      expect((await runRow(probe, runId))?.attempt).toBe(1);
      expect(await derivedReservation(probe, await currentPeriod(probe))).toBe("0");
    },
    240_000,
  );
});
