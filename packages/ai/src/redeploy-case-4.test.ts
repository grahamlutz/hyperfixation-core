import { defineApp, type App } from "@hyperfixation/core";
import {
  assertNoFencingFailure,
  createTestDatabase,
  killAt,
  parkedMarker,
  spawnWorker,
  testBuildSha,
  waitForWorkflowStatus,
  type TestDatabase,
} from "@hyperfixation/testing";
import { getClient, resetClient } from "@hyperfixation/workflows";
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
const V2_MODULE = new URL("./test-support/llm-flow-v2-fixture.ts", import.meta.url).pathname;

const KEYS = Array.from({ length: 16 }, (_, index) => `r${String(index).padStart(2, "0")}`);
/** Where worker A is holding when the pause lands, so "mid-loop" is arranged, not timed. */
const PAUSE_AT = KEYS[5]!;

/**
 * Redeploy case 4. The pause gate and a redeploy are the same primitive as an approval: the
 * workflow *ends*, and a later one starts fresh for the same run. So the assertions are the
 * same three — the run parks, the new version picks it up, and the ledger's cached rows mean
 * the replayed half of the loop costs nothing.
 */
describe("redeploy case 4 — pause and resume across a redeploy", () => {
  let database: TestDatabase;
  let probe: LedgerProbe;
  let app: App;
  const versionB = testBuildSha();

  beforeAll(async () => {
    database = await createTestDatabase();
    probe = ledgerProbe(database);
    await seedAppState(database, "100");

    // The app as the *web* holds it: its own pool and `getClient()`, no control pool and no
    // DBOS launch. `applicationVersion` is the deploy's, which both containers share.
    app = defineApp({
      name: database.appName,
      applicationVersion: versionB,
      flows: [llmFlow()],
    });
    app.attach({
      pool: probe.pool,
      client: await getClient({
        appName: database.appName,
        databaseUrl: database.applicationUrl,
      }),
    });
  }, 60_000);

  afterAll(async () => {
    // The control plane is on the process, not on this file: the probe below is about to be
    // closed, and an attachment left behind is one the next file in this worker would find.
    app?.detach();
    await resetClient();
    await probe?.close();
    await database?.drop();
  });

  it(
    "parks the run at its next step, survives a new SHA, and finishes with no extra calls",
    async () => {
      const runId = `case4-${versionB}`;
      const flow = llmFlow();
      const input = { keys: KEYS, estimatedCostUsd: 0.01, costUsd: 0.005 };

      const workerA = spawnWorker({
        module: V1_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
        control: { killAt: killAt(PAUSE_AT, "after-checkpoint") },
      });
      let callsA: number;
      try {
        await workerA.ready();
        await startRun(probe, flow, input, runId);
        await workerA.waitFor(parkedMarker(killAt(PAUSE_AT, "after-checkpoint")), 60_000);

        const paused = await app.pause({ userId: "graham" });
        expect(paused.queues.map((queue) => [queue.name, queue.globalConcurrency])).toEqual([
          ["llm", 0],
          ["actions", 0],
        ]);
        expect(await queueConcurrency()).toEqual({ actions: 0, llm: 0, resolve: 1 });

        // The worker was already inside the loop when the pause landed; it stops at the *next*
        // step, which is the whole contract — a pause never interrupts a step body.
        workerA.release();
        await waitForStatus(probe, runId, "paused", 60_000);
        assertNoFencingFailure(workerA);
        callsA = providerCalls(workerA.output());

        // Polled: `paused` is committed from inside the body, so DBOS marks the attempt
        // SUCCESS only once that body returns.
        await waitForWorkflowStatus(probe.pool, runId, "SUCCESS", { timeoutMs: 30_000 });
        expect((await runRow(probe, runId))?.attempt).toBe(1);
        expect(callsA).toBe(KEYS.indexOf(PAUSE_AT) + 1);

        await workerA.shutdown();
      } finally {
        await workerA.kill().catch(() => undefined);
      }

      const workerB = spawnWorker({
        module: V2_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
        version: versionB,
      });
      let callsB: number;
      try {
        await workerB.ready();
        // A deploy re-registers the queues at their registered concurrency; a worker coming up
        // into a paused app puts them back to zero before it is ready to dispatch.
        expect(await queueConcurrency()).toEqual({ actions: 0, llm: 0, resolve: 1 });
        expect((await runRow(probe, runId))?.status).toBe("paused");

        const resumed = await app.resume({ userId: "graham" });
        expect(resumed.queues.map((queue) => [queue.name, queue.globalConcurrency])).toEqual([
          ["llm", 4],
          ["actions", 2],
        ]);
        expect(await queueConcurrency()).toEqual({ actions: 2, llm: 4, resolve: 1 });
        expect(resumed.reconciled.reattempted).toEqual([
          { runId, attempt: 2, workflowId: `${runId}:2`, reason: "resumed" },
        ]);

        await waitForStatus(probe, runId, "done", 120_000);
        assertNoFencingFailure(workerB);
        callsB = providerCalls(workerB.output());
        await workerB.shutdown();
      } finally {
        await workerB.kill().catch(() => undefined);
      }

      // The point of the case: attempt 2 re-runs the flow from the top and the keys attempt 1
      // finished are served from their ledger rows, so the provider is called once per key
      // across the whole redeploy.
      expect(callsA + callsB).toBe(KEYS.length);

      const rows = await ledgerRows(probe, runId);
      expect(rows.map((row) => row.key)).toEqual([...KEYS].sort());
      expect(rows.filter((row) => row.status !== "ok")).toEqual([]);
      expect(rows.filter((row) => row.possible_double_charge)).toEqual([]);
      expect(await runRow(probe, runId)).toMatchObject({
        status: "done",
        attempt: 2,
        current_workflow_id: `${runId}:2`,
      });
      expect(await derivedReservation(probe, await currentPeriod(probe))).toBe("0");

      const status = await app.status();
      expect(status).toMatchObject({ paused: false, applicationVersion: versionB, anomalies: 0 });
      expect(status.runs.done).toBe(1);
    },
    300_000,
  );

  async function queueConcurrency(): Promise<Record<string, number | null>> {
    const { rows } = await probe.pool.query<{ name: string; concurrency: number | null }>(
      "SELECT name, concurrency FROM dbos.queues ORDER BY name",
    );
    return Object.fromEntries(rows.map((row) => [row.name, row.concurrency]));
  }
});
