import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  createTestDatabase,
  killAt,
  killWhenParked,
  spawnWorker,
  testBuildSha,
  type TestDatabase,
} from "@hyperfixation/testing";
import { getClient, reconcile, resetClient } from "@hyperfixation/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  budgetPeriod,
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
 * transitions it — the reservation's `r.status = 'running'` clause is what makes that true.
 *
 * Chunk 11 adds the idempotency half: `reconcile()`'s hygiene step moves the row to `abandoned`
 * exactly once, whatever the interval, because the transition's own predicate is the status it
 * leaves. That is audit and hygiene; the budget was already whole at the bump.
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
    "reserves nothing for the row, abandons it once, and still refuses the next run",
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
      let client: DBOSClient;
      try {
        // Worker B's own boot `reconcile()` cancels the attempt A left behind and enqueues
        // attempt 2, which is the one that fails.
        await workerB.ready();
        await waitForStatus(probe, orphanedRun, "failed", 90_000);
        client = await getClient({
          appName: database.appName,
          databaseUrl: database.applicationUrl,
        });
        await workerB.shutdown();
      } finally {
        await workerB.kill().catch(() => undefined);
      }

      const period = await currentPeriod(probe);
      // The reservation was whole again at the bump, before any pass ran: the row's own status
      // never had to change for that. Abandoning it is hygiene and audit on top, and worker B's
      // boot pass is what did it — the row stopped being its run's current attempt at the bump.
      expect(await derivedReservation(probe, period)).toBe("0");
      const abandoned = (await ledgerRows(probe, orphanedRun))[0];
      expect(abandoned).toMatchObject({ status: "abandoned" });

      // Three further passes over the same row. `WHERE status = 'started'` is the idempotency,
      // so none of them transitions anything and the one `finished_at` does not move.
      for (let pass = 0; pass < 3; pass += 1) {
        const report = await reconcile(probe.pool, client, { applicationVersion: workerB.version });
        expect(report.abandonedLlmCalls).toBe(0);
      }
      expect((await ledgerRows(probe, orphanedRun))[0]).toEqual(abandoned);
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
