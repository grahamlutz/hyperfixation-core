import { createStepPool, type StepPool } from "@hyperfixation/db";
import {
  asRole,
  createTestDatabase,
  MockLanguageModel,
  MOCK_MODEL_ID,
  type TestDatabase,
} from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UnknownModel } from "./errors.js";
import { createLlm, type LedgerContext } from "./llm-run.js";
import { createProviders, perMillionTokens } from "./providers.js";
import { PROMPTS_DIR } from "./test-support/prompts-dir.js";

describe("the provider registry", () => {
  it("resolves a default-table name through the provider its cost row names", () => {
    const providers = createProviders({ anthropic: { apiKey: "not-a-key" } });
    const model = providers.model("claude-sonnet-4-5");

    expect(model.provider).toBe("anthropic.messages");
    expect(model.modelId).toBe("claude-sonnet-4-5");
    expect(providers.cost("claude-sonnet-4-5").provider).toBe("anthropic");
  });

  it("lets an explicit models entry win over the provider lookup", () => {
    const mock = new MockLanguageModel();
    const providers = createProviders({
      anthropic: { apiKey: "not-a-key" },
      models: { "claude-sonnet-4-5": mock },
    });

    expect(providers.model("claude-sonnet-4-5")).toBe(mock);
  });

  it("refuses a name no provider is configured for", () => {
    const providers = createProviders();

    expect(() => providers.model("claude-sonnet-4-5")).toThrow(UnknownModel);
    expect(() => providers.model("not-a-model")).toThrow(UnknownModel);
    // A model handed in without a price would bill the budget nothing per call.
    expect(() => providers.cost(MOCK_MODEL_ID)).toThrow(UnknownModel);
  });

  it("prices a call per million tokens, four bytes to the token", () => {
    const cost = perMillionTokens({
      provider: "openai",
      input: 2,
      output: 8,
      assumedOutputTokens: 500,
    });

    // 4,000 bytes is 1,000 input tokens at $2/M, plus the assumed 500 out at $8/M.
    expect(cost.estimate({ promptBytes: 1_000, inputBytes: 3_000 })).toBeCloseTo(0.006, 10);
    expect(cost.estimate({ promptBytes: 1_000, inputBytes: 3_000, maxOutputTokens: 1_000 })).toBeCloseTo(
      0.01,
      10,
    );
    expect(cost.actual({ inputTokens: 500_000, outputTokens: 250_000 })).toBeCloseTo(3, 10);
    expect(cost.actual({})).toBe(0);
  });
});

/** An unknown name throws where nothing has happened yet: before the gate, before the call. */
describe("an unknown model name", () => {
  let database: TestDatabase;
  let steps: StepPool;

  beforeAll(async () => {
    database = await createTestDatabase();
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, 100)");
    });
    steps = createStepPool({ connectionString: database.applicationUrl });
  }, 60_000);

  afterAll(async () => {
    await steps?.end();
    await database?.drop();
  });

  it("leaves no ledger row behind", async () => {
    const runId = "unknown-model";
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query(
        "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
          "VALUES ($1, 'test', '{}', 'running', 1, $1)",
        [runId],
      );
    });
    const ctx: LedgerContext = { runId, workflowId: runId, tx: (work) => steps.tx(runId, runId, work) };
    const llm = createLlm({ providers: createProviders(), promptsDir: PROMPTS_DIR });

    await expect(
      llm.run(ctx, { key: "k", model: "typo-model", prompt: "draft", input: {} }),
    ).rejects.toBeInstanceOf(UnknownModel);

    const rows = await asRole(database.applicationUrl, async (pg) => {
      const result = await pg.query("SELECT 1 FROM hf_llm_call WHERE run_id = $1", [runId]);
      return result.rowCount;
    });
    expect(rows).toBe(0);
  });
});
