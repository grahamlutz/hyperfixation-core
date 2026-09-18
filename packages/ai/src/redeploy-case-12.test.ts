import {
  createTestDatabase,
  killAt,
  spawnWorker,
  testBuildSha,
  type TestDatabase,
} from "@hyperfixation/testing";
import { reconcile, resetClient, getClient } from "@hyperfixation/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  budgetPeriod,
  currentPeriod,
  derivedReservation,
  ledgerProbe,
  runRow,
  seedAppState,
  startRun,
  type LedgerProbe,
} from "./test-support/ledger-harness.js";
import { llmFlow } from "./test-support/llm-flow.js";

const V1_MODULE = new URL("./test-support/llm-flow-v1-fixture.ts", import.meta.url).pathname;
const V2_MODULE = new URL("./test-support/llm-flow-v2-fixture.ts", import.meta.url).pathname;

const BUDGET_USD = "10.00";
const RUNS = 50;
const ESTIMATED_COST_USD = 1.0;
const COST_USD = 0.1;
const KEY = "x";

/**
 * How many of the fifty are crashed for real. The `llm` queue's global concurrency is 4, and a
 * run parked before its checkpoint never frees its slot — so four is every run worker A can
 * physically have in flight at once, and the rest are put into the identical state by hand
 * (asserted below, column by column, against one of the four).
 */
const GENUINE_CRASHES = 4;

interface Synthesised {
  input_hash: string;
  model: string | null;
  input: unknown;
}

/**
 * Redeploy case 12, round-3 finding 6: a redeploy must not destroy a backlog through false
 * budget failures. Fifty `running` runs each hold a `$1` `started` row written by an attempt a
 * dead version left behind — $50 of phantom reservations against a $10 budget. The reservation
 * is scoped to the live attempt, so the bumps alone take it to zero, in the bumps' own
 * transactions, with no reconcile interval to wait for.
 */
describe("redeploy case 12 — the redeploy backlog", () => {
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
    "bumps fifty runs to a reservation of zero and completes every one of them",
    async () => {
      const flow = llmFlow();
      const input = { keys: [KEY], estimatedCostUsd: ESTIMATED_COST_USD, costUsd: COST_USD };
      const runIds = Array.from({ length: RUNS }, (_, i) => `case12-${testBuildSha()}-${i}`);
      const versionA = testBuildSha();
      const versionB = testBuildSha();

      const workerA = spawnWorker({
        module: V1_MODULE,
        version: versionA,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
        control: { killAt: killAt(KEY, "before-checkpoint") },
      });
      try {
        await workerA.ready();
        for (const runId of runIds) await startRun(probe, flow, input, runId);
        await waitForStartedRows(probe, GENUINE_CRASHES, 120_000);
      } finally {
        await workerA.kill().catch(() => undefined);
      }

      const period = await currentPeriod(probe);
      const crashed = await startedRunIds(probe);
      expect(crashed).toHaveLength(GENUINE_CRASHES);
      await synthesiseCrashedAttempts(probe, runIds, crashed, versionA, period);

      // $50 of `started` rows, every one of them still its run's current attempt: this is the
      // state that reserves, and the number the whole case is about.
      expect(await derivedReservation(probe, period)).toBe("50.000000");

      // The redeploy, driven here rather than by worker B's own boot pass so the reservation
      // can be read at the one instant that matters: after the bumps, before any attempt-2 step.
      const client = await getClient({
        appName: database.appName,
        databaseUrl: database.applicationUrl,
      });
      const report = await reconcile(probe.pool, client, { applicationVersion: versionB });

      expect(report.failures).toEqual([]);
      expect(report.reattempted).toHaveLength(RUNS);
      expect(await derivedReservation(probe, period)).toBe("0");

      const workerB = spawnWorker({
        module: V2_MODULE,
        version: versionB,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
      });
      try {
        await workerB.ready();
        await waitForRuns(probe, runIds, "done", 300_000);
        await workerB.shutdown();
      } finally {
        await workerB.kill().catch(() => undefined);
      }

      for (const runId of runIds) {
        expect(await runRow(probe, runId)).toMatchObject({ status: "done", attempt: 2 });
      }
      const ledger = await allLedgerRows(probe);
      expect(ledger).toHaveLength(RUNS);
      expect(ledger.every((row) => row.status === "ok")).toBe(true);
      // Every one of the fifty had a provider call it cannot prove was not billed. The flag is
      // the whole audit trail for that, and a replay never gets to hide it.
      expect(ledger.every((row) => row.possible_double_charge)).toBe(true);
      expect(await derivedReservation(probe, period)).toBe("0");
      expect(Number((await budgetPeriod(probe, period))?.spent_usd)).toBeCloseTo(
        RUNS * COST_USD,
        4,
      );
      expect(workerB.output()).not.toContain("BudgetExceeded");
    },
    600_000,
  );
});

async function startedRunIds(probe: LedgerProbe): Promise<string[]> {
  const { rows } = await probe.pool.query<{ run_id: string }>(
    "SELECT run_id FROM hf_llm_call WHERE status = 'started' ORDER BY run_id",
  );
  return rows.map((row) => row.run_id);
}

async function allLedgerRows(
  probe: LedgerProbe,
): Promise<{ status: string; possible_double_charge: boolean }[]> {
  const { rows } = await probe.pool.query<{ status: string; possible_double_charge: boolean }>(
    "SELECT status, possible_double_charge FROM hf_llm_call ORDER BY run_id",
  );
  return rows;
}

async function waitForStartedRows(
  probe: LedgerProbe,
  count: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const started = await startedRunIds(probe);
    if (started.length >= count) return;
    if (Date.now() > deadline) {
      throw new Error(`only ${started.length} of ${count} runs reached a started row`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function waitForRuns(
  probe: LedgerProbe,
  runIds: string[],
  status: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await probe.pool.query<{ done: string }>(
      "SELECT count(*)::text AS done FROM hf_run WHERE status = $1 AND run_id = ANY($2)",
      [status, runIds],
    );
    if (Number(rows[0]!.done) === runIds.length) return;
    if (Date.now() > deadline) {
      throw new Error(`only ${rows[0]!.done} of ${runIds.length} runs reached ${status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Puts every run worker A could not reach into the state its four in-flight runs are in: the
 * attempt claimed and `PENDING` under A's version, with a `started` ledger row under that
 * attempt's workflow id. The row is copied from a genuine one so the replaying attempt's
 * `input_hash` matches and the case tests the ledger's replay path rather than
 * `LedgerKeyCollision`.
 */
async function synthesiseCrashedAttempts(
  probe: LedgerProbe,
  runIds: string[],
  crashed: string[],
  versionA: string,
  period: string,
): Promise<void> {
  const { rows } = await probe.pool.query<Synthesised>(
    "SELECT input_hash, model, input FROM hf_llm_call WHERE run_id = $1",
    [crashed[0]],
  );
  const template = rows[0]!;

  for (const runId of runIds) {
    if (crashed.includes(runId)) continue;
    await probe.pool.query(
      "UPDATE dbos.workflow_status SET status = 'PENDING', application_version = $2 " +
        "WHERE workflow_uuid = $1",
      [runId, versionA],
    );
    await probe.pool.query(
      "INSERT INTO hf_llm_call (run_id, key, workflow_id, period, input_hash, model, status, " +
        "input, estimated_cost_usd) VALUES ($1, $2, $1, $3, $4, $5, 'started', $6::jsonb, $7)",
      [
        runId,
        KEY,
        period,
        template.input_hash,
        template.model,
        JSON.stringify(template.input),
        ESTIMATED_COST_USD,
      ],
    );
  }

  // The synthesis is only honest if it is indistinguishable from the real thing.
  const { rows: shapes } = await probe.pool.query<{ shape: string }>(
    "SELECT DISTINCT status || '|' || workflow_id_is_run || '|' || period AS shape FROM (" +
      "SELECT status, (workflow_id = run_id)::text AS workflow_id_is_run, period " +
      "FROM hf_llm_call) s",
  );
  expect(shapes).toEqual([{ shape: `started|true|${period}` }]);
}
