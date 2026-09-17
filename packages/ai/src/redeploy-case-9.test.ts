import {
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
  bumpAndEnqueue,
  currentPeriod,
  derivedReservation,
  ledgerProbe,
  ledgerRows,
  runRow,
  seedAppState,
  startRun,
  waitForStatus,
  type LedgerProbe,
} from "./test-support/ledger-harness.js";
import { llmFlow } from "./test-support/llm-flow.js";

const V1_MODULE = new URL("./test-support/llm-flow-v1-fixture.ts", import.meta.url).pathname;
const FAILING_MODULE = new URL(
  "./test-support/llm-flow-failing-fixture.ts",
  import.meta.url,
).pathname;

const BUDGET_USD = "1.00";

/**
 * Redeploy case 9, the adversary's round-2 finding 3: a `started` row orphaned by a run that
 * genuinely failed. The load-bearing claim is that such a row reserves nothing *before* anything
 * transitions it — the reservation's `r.status = 'running'` clause is what makes that true, and
 * the assertion below is deliberately taken while the row is still `started`.
 *
 * `reconcile()`'s hygiene half — moving the row to `abandoned` — lands in chunk 11 and is tested
 * there; it is audit, not budget correctness.
 */
describe("redeploy case 9 — an orphaned reservation on a failed run", () => {
  let database: TestDatabase;
  let probe: LedgerProbe;

  beforeAll(async () => {
    database = await createTestDatabase();
    probe = ledgerProbe(database);
    await seedAppState(database, BUDGET_USD);
  }, 60_000);

  afterAll(async () => {
    await resetClient();
    await probe?.close();
    await database?.drop();
  });

  it(
    "leaves the row started, reserves nothing for it, and still refuses the next run",
    async () => {
      const flow = llmFlow();
      const orphanedRun = `case9-${testBuildSha()}`;

      const workerA = spawnWorker({
        module: V1_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
        control: { killAt: killAt("x", "before-checkpoint") },
      });
      try {
        await workerA.ready();
        await startRun(
          probe,
          flow,
          { keys: ["x"], estimatedCostUsd: 1.0, costUsd: 0.1 },
          orphanedRun,
        );
        await killWhenParked(workerA, killAt("x", "before-checkpoint"), 60_000);
      } finally {
        await workerA.kill().catch(() => undefined);
      }
      expect((await ledgerRows(probe, orphanedRun))[0]).toMatchObject({ status: "started" });

      const workerB = spawnWorker({
        module: FAILING_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
      });
      try {
        await workerB.ready();
        await bumpAndEnqueue(probe, flow, orphanedRun);
        await waitForStatus(probe, orphanedRun, "failed", 90_000);
        await workerB.shutdown();
      } finally {
        await workerB.kill().catch(() => undefined);
      }

      const period = await currentPeriod(probe);
      // Still `started`, and already reserving nothing: the row's own status did not have to
      // change for the budget to be whole again — its run leaving `running` was enough.
      expect((await ledgerRows(probe, orphanedRun))[0]).toMatchObject({ status: "started" });
      expect(await derivedReservation(probe, period)).toBe("0");
      expect(Number((await budgetPeriod(probe, period))?.spent_usd)).toBe(0);

      const freshRun = `case9-fresh-${testBuildSha()}`;
      const workerC = spawnWorker({
        module: V1_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
      });
      try {
        await workerC.ready();
        await startRun(
          probe,
          flow,
          { keys: ["x"], estimatedCostUsd: 1.5, costUsd: 0.1 },
          freshRun,
        );
        await waitForStatus(probe, freshRun, "failed", 90_000);
        await workerC.shutdown();
      } finally {
        await workerC.kill().catch(() => undefined);
      }

      // 1.50 against a 1.00 budget with nothing spent and nothing reserved: the kill switch
      // still fires, and the refused gate leaves no row behind.
      expect((await runRow(probe, freshRun))?.error).toContain("BudgetExceeded");
      expect(await ledgerRows(probe, freshRun)).toEqual([]);

      const before = await runRow(probe, orphanedRun);
      await expect(
        startRun(probe, flow, { keys: ["x"], estimatedCostUsd: 1.0, costUsd: 0.1 }, orphanedRun),
      ).rejects.toMatchObject({ code: "23505" });
      expect(await runRow(probe, orphanedRun)).toEqual(before);
    },
    300_000,
  );
});
