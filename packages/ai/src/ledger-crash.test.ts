import { createStepPool, type StepPool } from "@hyperfixation/db";
import {
  asRole,
  assertNoFencingFailure,
  createTestDatabase,
  killAt,
  killWhenParked,
  MockLanguageModel,
  MOCK_MODEL_ID,
  spawnWorker,
  testBuildSha,
  type TestDatabase,
} from "@hyperfixation/testing";
import { resetClient } from "@hyperfixation/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LedgerKeyCollision } from "./errors.js";
import { createLlm, type LedgerContext, type Llm } from "./llm-run.js";
import { createProviders, fixedCost } from "./providers.js";
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
import { PROMPTS_DIR } from "./test-support/prompts-dir.js";

const V1_MODULE = new URL("./test-support/llm-flow-v1-fixture.ts", import.meta.url).pathname;

const KEYS = Array.from({ length: 12 }, (_, index) => `r${String(index).padStart(2, "0")}`);
const KILL_AT = KEYS[6]!;
const COST_USD = 0.005;

const LOOP_KEYS = Array.from({ length: 1000 }, (_, index) => `k${String(index).padStart(4, "0")}`);
const LOOP_COST_USD = 0.001;

/** The registry a cassette needs: one named model, one flat price, one prompt directory. */
function ledger(model: MockLanguageModel, costUsd: number): Llm {
  return createLlm({
    providers: createProviders({
      models: { [MOCK_MODEL_ID]: model },
      costs: { [MOCK_MODEL_ID]: fixedCost(costUsd, costUsd) },
    }),
    promptsDir: PROMPTS_DIR,
  });
}

/**
 * The ledger under a crash, same version on both sides of it — the Phase 2 verification's own
 * file. The two crash cases drive redeploy case 3's fixture; the loop and the collision need no
 * worker and go straight through `ctx.tx`.
 */
describe("the ledger under a same-version crash", () => {
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
    "killed after the checkpoint, makes no extra provider call and flags nothing",
    async () => {
      const version = testBuildSha();
      const runId = `crash-after-${version}`;
      const flow = llmFlow();
      const input = { keys: KEYS, estimatedCostUsd: 0.01, costUsd: COST_USD };

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
      expect(await runRow(probe, runId)).toMatchObject({ status: "done", attempt: 1 });
      expect(await derivedReservation(probe, await currentPeriod(probe))).toBe("0");
    },
    240_000,
  );

  it(
    "killed before the checkpoint, makes one extra call and flags the one row",
    async () => {
      const version = testBuildSha();
      const runId = `crash-before-${version}`;
      const flow = llmFlow();
      const input = { keys: KEYS, estimatedCostUsd: 0.01, costUsd: COST_USD };

      const workerA = spawnWorker({
        module: V1_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
        version,
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
      // The provider answered for `KILL_AT` and its row is still `started`: the one state that
      // costs money twice, here without a redeploy to explain it.
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

      expect(callsA + callsB).toBe(KEYS.length + 1);

      const rows = await ledgerRows(probe, runId);
      expect(rows.map((row) => row.key)).toEqual([...KEYS].sort());
      expect(rows.filter((row) => row.status !== "ok")).toEqual([]);
      expect(rows.filter((row) => row.possible_double_charge).map((row) => row.key)).toEqual([
        KILL_AT,
      ]);
      expect(await runRow(probe, runId)).toMatchObject({ status: "done", attempt: 1 });
      expect(await derivedReservation(probe, await currentPeriod(probe))).toBe("0");
    },
    240_000,
  );
});

describe("a thousand ledgered calls in one run", () => {
  let database: TestDatabase;
  let probe: LedgerProbe;
  let steps: StepPool;

  beforeAll(async () => {
    database = await createTestDatabase();
    probe = ledgerProbe(database);
    await seedAppState(database, "100");
    steps = createStepPool({ connectionString: database.applicationUrl });
  }, 60_000);

  afterAll(async () => {
    await steps?.end();
    await probe?.close();
    await database?.drop();
  });

  it(
    "writes one row per key and bills the period once per call",
    async () => {
      const runId = "loop-1000";
      const ctx = await runningRun(database, steps, runId);
      const model = new MockLanguageModel({
        responses: LOOP_KEYS.map((key) => ({
          text: `answer:${key}`,
          inputTokens: 10,
          outputTokens: 5,
        })),
      });
      const llm = ledger(model, LOOP_COST_USD);

      for (const key of LOOP_KEYS) {
        await llm.run(ctx, { key, model: MOCK_MODEL_ID, prompt: "draft", input: { key } });
      }

      expect(model.callCount).toBe(LOOP_KEYS.length);
      const rows = await ledgerRows(probe, runId);
      expect(rows).toHaveLength(LOOP_KEYS.length);
      expect(rows.map((row) => row.key)).toEqual([...LOOP_KEYS].sort());
      expect(rows.filter((row) => row.status !== "ok")).toEqual([]);
      expect(rows.filter((row) => row.possible_double_charge)).toEqual([]);

      const period = await currentPeriod(probe);
      expect(Number((await budgetPeriod(probe, period))?.spent_usd)).toBeCloseTo(
        LOOP_KEYS.length * LOOP_COST_USD,
        6,
      );
      expect(await derivedReservation(probe, period)).toBe("0");
    },
    60_000,
  );
});

describe("one key, two different inputs", () => {
  let database: TestDatabase;
  let probe: LedgerProbe;
  let steps: StepPool;

  beforeAll(async () => {
    database = await createTestDatabase();
    probe = ledgerProbe(database);
    await seedAppState(database, "100");
    steps = createStepPool({ connectionString: database.applicationUrl });
  }, 60_000);

  afterAll(async () => {
    await steps?.end();
    await probe?.close();
    await database?.drop();
  });

  it("throws LedgerKeyCollision without calling the provider again", async () => {
    const runId = "collision";
    const ctx = await runningRun(database, steps, runId);
    const model = new MockLanguageModel({ responses: [{ text: "one" }, { text: "two" }] });
    const llm = ledger(model, COST_USD);
    const call = { key: "k", model: MOCK_MODEL_ID, prompt: "draft" };

    await expect(llm.run(ctx, { ...call, input: { a: 1 } })).resolves.toEqual({ text: "one" });
    await expect(llm.run(ctx, { ...call, input: { a: 2 } })).rejects.toBeInstanceOf(
      LedgerKeyCollision,
    );

    expect(model.callCount).toBe(1);
    const rows = await ledgerRows(probe, runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "k", status: "ok", possible_double_charge: false });
  });
});

async function runningRun(
  database: TestDatabase,
  steps: StepPool,
  runId: string,
): Promise<LedgerContext> {
  await asRole(database.applicationUrl, async (pg) => {
    await pg.query(
      "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
        "VALUES ($1, 'test', '{}', 'running', 1, $1)",
      [runId],
    );
  });
  return { runId, workflowId: runId, tx: (work) => steps.tx(runId, runId, work) };
}
