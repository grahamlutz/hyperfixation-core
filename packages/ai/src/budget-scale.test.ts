/**
 * The scale of the period counter, from the X1 real-box finding: two Haiku 4.5 calls cost
 * $0.000838 and $0.000855, and `hf_budget_period.spent_usd` — `numeric(12,4)` until 0009 —
 * stored their sum as `0.0017` against a ledger of `0.001693`. Every settle is
 * `spent_usd = spent_usd + cost_usd`, so the rounding was of the *running total* and grew with
 * the number of calls; the cap was then compared against the rounded figure.
 *
 * Both cases bill to a period of their own through the injected clock, so neither sees the
 * other's spend and neither depends on what month the suite runs in.
 */
import { createStepPool, type StepPool } from "@hyperfixation/db";
import {
  createTestDatabase,
  MockLanguageModel,
  MOCK_MODEL_ID,
  testBuildSha,
  withClock,
  type TestDatabase,
} from "@hyperfixation/testing";
import { defineFlow, getClient, resetClient, type Flow } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BudgetExceeded } from "./errors.js";
import { createLlm, type LedgerContext, type Llm } from "./llm-run.js";
import { createProviders, fixedCost, perMillionTokens } from "./providers.js";
import { runRow, seedAppState, startRun, type LedgerProbe } from "./test-support/ledger-harness.js";
import { PROMPTS_DIR } from "./test-support/prompts-dir.js";

const BUDGET_USD = "1000";
const PROBE_POOL_SIZE = 4;

/** Haiku 4.5's list price, the one the finding's two calls were billed at. */
const HAIKU_COST = perMillionTokens({ provider: "anthropic", input: 1, output: 5 });

/** The finding's two calls, token for token: $0.000838 and $0.000855. */
const USAGE = [
  { inputTokens: 488, outputTokens: 70 },
  { inputTokens: 485, outputTokens: 74 },
];

const CALLS = 200;

let database: TestDatabase;
let probe: LedgerProbe;
let steps: StepPool;
let flow: Flow<{ n: number }, void>;

function llmFor(model: MockLanguageModel, cost: typeof HAIKU_COST, clock: () => Date): Llm {
  return createLlm({
    providers: createProviders({
      models: { [MOCK_MODEL_ID]: model },
      costs: { [MOCK_MODEL_ID]: cost },
    }),
    promptsDir: PROMPTS_DIR,
    clock,
  });
}

/** The workflow the run is actually on: a reservation only counts under that one. */
async function liveContext(runId: string): Promise<LedgerContext> {
  const workflowId = (await runRow(probe, runId))!.current_workflow_id;
  return { runId, workflowId, tx: (work) => steps.tx(runId, workflowId, work) };
}

async function seedPeriod(period: string, budgetUsd: string): Promise<void> {
  await probe.pool.query(
    "INSERT INTO hf_budget_period (period, budget_usd) VALUES ($1, $2) " +
      "ON CONFLICT (period) DO UPDATE SET budget_usd = $2",
    [period, budgetUsd],
  );
}

/** `spent_usd`, the ledger sum and the difference, all read at the scale both sides store. */
async function periodTotals(
  period: string,
): Promise<{ spent: string; ledger: string; drift: string }> {
  const { rows } = await probe.pool.query<{ spent: string; ledger: string; drift: string }>(
    `SELECT b.spent_usd::text AS spent, l.ledger::numeric(12,6)::text AS ledger,
            (b.spent_usd - l.ledger)::numeric(12,6)::text AS drift
     FROM hf_budget_period b CROSS JOIN LATERAL (
       SELECT COALESCE(SUM(c.cost_usd), 0) AS ledger FROM hf_llm_call c
       WHERE c.period = b.period AND c.status = 'ok') l
     WHERE b.period = $1`,
    [period],
  );
  return rows[0]!;
}

beforeAll(async () => {
  database = await createTestDatabase();
  const pool = new Pool({ max: PROBE_POOL_SIZE, connectionString: database.applicationUrl });
  probe = { database, pool, close: () => pool.end() };
  await seedAppState(database, BUDGET_USD);
  steps = createStepPool({ connectionString: database.applicationUrl });
  await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
  flow = defineFlow<{ n: number }, void>("budgetScaleFlow", () => Promise.resolve(), {
    queue: "llm",
  });
}, 120_000);

afterAll(async () => {
  await resetClient();
  await steps?.end();
  await probe?.close();
  await database?.drop();
});

describe("budget-scale.test.ts (a) — 200 settles of a real price", () => {
  const PERIOD = "2099-03";

  it("lands on a spent_usd exactly equal to the ledger, with no drift at all", async () => {
    const runId = `budget-scale-${testBuildSha()}`;
    await startRun(probe, flow, { n: 1 }, runId);
    await seedPeriod(PERIOD, BUDGET_USD);

    const model = new MockLanguageModel({
      responses: Array.from({ length: CALLS }, (_, i) => ({
        text: `answer ${i}`,
        ...USAGE[i % USAGE.length]!,
      })),
    });
    const llm = llmFor(model, HAIKU_COST, withClock("2099-03-15T12:00:00Z"));
    const ctx = await liveContext(runId);

    for (let i = 0; i < CALLS; i += 1) {
      await llm.run(ctx, { key: `c${i}`, model: MOCK_MODEL_ID, prompt: "draft", input: { i } });
    }

    expect(model.callCount).toBe(CALLS);
    // 100 × $0.000838 + 100 × $0.000855. At scale 4 the counter rounded once per settle and
    // came out cents-of-a-cent low; at scale 6 it is the sum itself.
    expect(await periodTotals(PERIOD)).toEqual({
      spent: "0.169300",
      ledger: "0.169300",
      drift: "0.000000",
    });
  }, 300_000);
});

describe("budget-scale.test.ts (b) — the cap on a fractional price", () => {
  const PERIOD = "2099-04";
  const COST_USD = 0.000838;
  const FITS = 5;
  /** Above five calls, below six — the window a counter that rounds down walks straight through. */
  const PERIOD_BUDGET_USD = "0.004900";

  it("refuses the first call that does not fit, counting at the ledger's scale", async () => {
    const runId = `budget-cap-${testBuildSha()}`;
    await startRun(probe, flow, { n: 1 }, runId);
    await seedPeriod(PERIOD, PERIOD_BUDGET_USD);

    const model = new MockLanguageModel({
      responses: Array.from({ length: FITS }, (_, i) => ({ text: `answer ${i}` })),
    });
    const llm = llmFor(model, fixedCost(COST_USD, COST_USD), withClock("2099-04-15T12:00:00Z"));
    const ctx = await liveContext(runId);

    for (let i = 0; i < FITS; i += 1) {
      await llm.run(ctx, { key: `k${i}`, model: MOCK_MODEL_ID, prompt: "draft", input: { i } });
    }

    await expect(
      llm.run(ctx, { key: `k${FITS}`, model: MOCK_MODEL_ID, prompt: "draft", input: { n: FITS } }),
    ).rejects.toBeInstanceOf(BudgetExceeded);

    // The cassette holds five answers, so a sixth provider call would have thrown
    // `CassetteExhausted` instead — the gate refused before the provider, not after it.
    expect(model.callCount).toBe(FITS);
    expect(await periodTotals(PERIOD)).toEqual({
      spent: "0.004190",
      ledger: "0.004190",
      drift: "0.000000",
    });
  }, 120_000);
});
