import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createStepPool, type StepPool } from "@hyperfixation/db";
import {
  asRole,
  createTestDatabase,
  MockLanguageModel,
  MOCK_MODEL_ID,
  type TestDatabase,
} from "@hyperfixation/testing";
import { context as otelContext, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLlm, type LedgerContext, type Llm } from "./llm-run.js";
import { createProviders, fixedCost } from "./providers.js";
import { PROMPTS_DIR } from "./test-support/prompts-dir.js";

function ledger(model: LanguageModelV4): Llm {
  return createLlm({
    providers: createProviders({
      models: { [MOCK_MODEL_ID]: model },
      costs: { [MOCK_MODEL_ID]: fixedCost(0.01, 0.01) },
    }),
    promptsDir: PROMPTS_DIR,
  });
}

const CALL = { key: "k", model: MOCK_MODEL_ID, prompt: "draft", input: { a: 1 } };

/**
 * The OTel registration below is process-wide, which is why this file holds nothing else and
 * tears both globals down in `afterAll`. The `startActiveSpan` around the call stands in for the
 * DBOS step span a real flow runs under — `startWorker()` cannot be launched in-process.
 */
describe("the trace id on the ledger row", () => {
  let database: TestDatabase;
  let steps: StepPool;
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(async () => {
    database = await createTestDatabase();
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, 100)");
    });
    steps = createStepPool({ connectionString: database.applicationUrl });
  }, 60_000);

  afterAll(async () => {
    trace.disable();
    otelContext.disable();
    await provider.shutdown();
    await steps?.end();
    await database?.drop();
  });

  async function context(runId: string): Promise<LedgerContext> {
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query(
        "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
          "VALUES ($1, 'test', '{}', 'running', 1, $1)",
        [runId],
      );
    });
    return { runId, workflowId: runId, tx: (work) => steps.tx(runId, runId, work) };
  }

  async function traceIdOf(runId: string): Promise<unknown> {
    return asRole(database.applicationUrl, async (pg) => {
      const { rows } = await pg.query<{ trace_id: string | null }>(
        "SELECT trace_id FROM hf_llm_call WHERE run_id = $1 AND key = 'k'",
        [runId],
      );
      return rows[0]?.trace_id;
    });
  }

  // First, so it runs against the no-op proxy tracer the unset-keys worker leaves in place.
  it("is null when no tracer provider is registered", async () => {
    const ctx = await context("trace-none");
    const llm = ledger(new MockLanguageModel({ responses: [{ text: "one" }] }));

    await expect(llm.run(ctx, CALL)).resolves.toEqual({ text: "one" });
    expect(await traceIdOf("trace-none")).toBeNull();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("is the enclosing span's trace, and the join fields land on the gen_ai span", async () => {
    contextManager.enable();
    otelContext.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);

    const ctx = await context("trace-join");
    const llm = ledger(new MockLanguageModel({ responses: [{ text: "two" }] }));

    const tracer = trace.getTracer("test");
    const stepTraceId = await tracer.startActiveSpan("step", async (span) => {
      try {
        await expect(llm.run(ctx, CALL)).resolves.toEqual({ text: "two" });
        return span.spanContext().traceId;
      } finally {
        span.end();
      }
    });

    expect(await traceIdOf("trace-join")).toBe(stepTraceId);

    // Two of the integration's three spans carry the runtime context: the operation root and
    // the step. The inference span below them (`chat mock-model`) does not.
    const joined = exporter.getFinishedSpans().filter(hasJoinFields);
    expect(joined.map((span) => span.name)).toEqual(["step 1", `invoke_agent ${MOCK_MODEL_ID}`]);
    for (const span of joined) {
      expect(span.spanContext().traceId).toBe(stepTraceId);
      expect(span.attributes).toMatchObject({
        "ai.settings.context.runId": "trace-join",
        "ai.settings.context.key": "k",
        "ai.settings.context.promptName": "draft",
      });
      expect(span.attributes["ai.settings.context.promptHash"]).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

function hasJoinFields(span: ReadableSpan): boolean {
  return span.attributes["ai.settings.context.runId"] !== undefined;
}
