import { createStepPool, type StepPool } from "@hyperfixation/db";
import {
  asRole,
  createTestDatabase,
  MockLanguageModel,
  MOCK_MODEL_ID,
  type TestDatabase,
} from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLlm } from "./llm-run.js";
import { createProviders, fixedCost } from "./providers.js";
import { PROMPTS_DIR } from "./test-support/prompts-dir.js";

/**
 * Its own file, apart from `trace-join.test.ts`, because that one registers a global tracer
 * provider and nothing in a module graph can un-register it for the SDK's cached tracer.
 */
describe("the trace id on the ledger row, with no tracer provider registered", () => {
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

  it("is null", async () => {
    const runId = "trace-none";
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query(
        "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
          "VALUES ($1, 'test', '{}', 'running', 1, $1)",
        [runId],
      );
    });
    const llm = createLlm({
      providers: createProviders({
        models: { [MOCK_MODEL_ID]: new MockLanguageModel({ responses: [{ text: "one" }] }) },
        costs: { [MOCK_MODEL_ID]: fixedCost(0.01, 0.01) },
      }),
      promptsDir: PROMPTS_DIR,
    });

    await expect(
      llm.run(
        { runId, workflowId: runId, tx: (work) => steps.tx(runId, runId, work) },
        { key: "k", model: MOCK_MODEL_ID, prompt: "draft", input: { a: 1 } },
      ),
    ).resolves.toEqual({ text: "one" });

    const traceId = await asRole(database.applicationUrl, async (pg) => {
      const { rows } = await pg.query<{ trace_id: string | null }>(
        "SELECT trace_id FROM hf_llm_call WHERE run_id = $1 AND key = 'k'",
        [runId],
      );
      return rows[0]?.trace_id;
    });
    expect(traceId).toBeNull();
  });
});
