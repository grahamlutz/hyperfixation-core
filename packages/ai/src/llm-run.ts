import { OpenTelemetry } from "@ai-sdk/otel";
import type { JSONSchema7 } from "@ai-sdk/provider";
import type { StepDatabase } from "@hyperfixation/db";
import { trace } from "@opentelemetry/api";
import { generateText, jsonSchema, Output } from "ai";
import { sql } from "drizzle-orm";
import { AppPaused, BudgetExceeded, LedgerKeyCollision } from "./errors.js";
import { hashInput } from "./input-hash.js";
import { loadPrompt } from "./prompts.js";
import type { ProviderRegistry } from "./providers.js";

/**
 * The subset of `@hyperfixation/workflows`' `StepContext` the ledger needs. Structural rather
 * than imported so this package does not depend on that one; a `StepContext` satisfies it.
 */
export interface LedgerContext {
  readonly runId: string;
  readonly workflowId: string;
  tx<T>(work: (db: StepDatabase) => Promise<T>): Promise<T>;
}

export interface LlmRunOptions {
  /** Unique within the run, and stable across attempts: the ledger row is keyed by it. */
  key: string;
  /** A registry model name; the registry resolves both the model and its price from it. */
  model: string;
  /** A file name under the llm's `promptsDir`, without the `.md`. */
  prompt: string;
  input: unknown;
  /** When set, the call asks for JSON and the answer is parsed rather than returned as text. */
  schema?: JSONSchema7;
}

export interface CreateLlmOptions {
  providers: ProviderRegistry;
  /** Where `prompt` names resolve: one directory of `.md` files. */
  promptsDir: string;
}

export interface Llm {
  run<O = { text: string }>(ctx: LedgerContext, options: LlmRunOptions): Promise<O>;
}

type GateOutcome =
  | { kind: "reserved"; period: string }
  | { kind: "cached"; output: unknown }
  | { kind: "failed"; error: Error };

/** Everything the two transactions write, resolved before either of them opens. */
interface LedgeredCall {
  key: string;
  model: string;
  input: unknown;
  inputHash: string;
  promptName: string;
  promptHash: string;
  estimatedCostUsd: number;
  /** The enclosing step span's trace, or undefined when nothing is recording. */
  traceId: string | undefined;
}

interface ProviderAnswer {
  output: unknown;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
}

interface LedgerRow extends Record<string, unknown> {
  status: string;
  input_hash: string;
  output: unknown;
  period: string;
}

interface StoredError {
  error?: { name?: string; message?: string };
}

/**
 * `llm.run(…)`, the name the plan and every flow use, bound to a registry and a prompt
 * directory. An app builds one at startup; a test builds one per call.
 */
export function createLlm({ providers, promptsDir }: CreateLlmOptions): Llm {
  return {
    run: <O,>(ctx: LedgerContext, options: LlmRunOptions): Promise<O> =>
      runCall<O>(ctx, options, providers, promptsDir),
  };
}

/**
 * One billable provider call, ledgered.
 *
 * Called from inside a `step()` body, whose `ctx` supplies `tx` — so `hf_run` is locked
 * `FOR SHARE` as the first statement of every transaction below and the lock order
 * `hf_run → hf_budget_period → hf_llm_call` holds by construction. The gate and the completion
 * are two transactions with the provider call between them, never one: a transaction may not
 * be held open across a call that can take a minute.
 *
 * The guarantee is *at most one extra provider call per crash, always visible*
 * (`possible_double_charge`) — not exactly-once.
 *
 * `O` names what `schema` asks the model for; without a schema the output is `{ text }`.
 */
async function runCall<O>(
  ctx: LedgerContext,
  options: LlmRunOptions,
  providers: ProviderRegistry,
  promptsDir: string,
): Promise<O> {
  // Both throw before the gate opens: an unknown name or a missing file leaves no row and
  // makes no call.
  const model = providers.model(options.model);
  const cost = providers.cost(options.model);
  const prompt = await loadPrompt(promptsDir, options.prompt);

  const userText = userTextOf(options.input);
  const call: LedgeredCall = {
    key: options.key,
    model: options.model,
    input: options.input,
    inputHash: hashInput(options.input),
    promptName: prompt.name,
    promptHash: prompt.hash,
    estimatedCostUsd: cost.estimate({
      promptBytes: Buffer.byteLength(prompt.text),
      inputBytes: Buffer.byteLength(userText),
    }),
    // Read before the gate so the row carries it even on the branches that never call the
    // provider; the SDK's own spans are children of the same trace.
    traceId: trace.getActiveSpan()?.spanContext().traceId,
  };

  const gate = await openGate(ctx, call);
  if (gate.kind === "cached") return gate.output as O;
  // Committed before it is thrown: a failed call is not retried by replay, so the row that
  // records the failure has to outlive this attempt just as an `ok` row does.
  if (gate.kind === "failed") throw gate.error;

  const startedAt = Date.now();
  let answer: ProviderAnswer;
  try {
    answer = await callProvider(model, ctx, options, prompt.text, call.promptHash, userText);
  } catch (error) {
    await recordProviderError(ctx, call, error, Date.now() - startedAt);
    throw error;
  }

  // A provider that reported no usage at all bills nothing the estimate can be corrected with.
  const costUsd =
    answer.inputTokens === undefined && answer.outputTokens === undefined
      ? call.estimatedCostUsd
      : cost.actual({ inputTokens: answer.inputTokens, outputTokens: answer.outputTokens });

  await complete(ctx, call, gate.period, answer, costUsd, Date.now() - startedAt);
  return answer.output as O;
}

/**
 * The integration that turns the SDK's telemetry events into OTel spans, which is what Langfuse
 * exports. Per-call rather than `registerTelemetry()`: a test builds a `createLlm` per call and a
 * global registration would accumulate duplicates. The tracer it holds is the global proxy, so
 * one instance is correct whether or not a provider is ever registered.
 */
const telemetry = new OpenTelemetry({ runtimeContext: true });

/**
 * The SDK call. `maxRetries: 0` because the SDK's default of two would re-bill the provider
 * behind the ledger's back; a retry is the run's business, not the call's. The four join fields
 * travel as runtime context, which is how `ai@7`'s telemetry integrations receive them; the
 * integration re-emits them as `ai.settings.context.*` span attributes.
 */
async function callProvider(
  model: Parameters<typeof generateText>[0]["model"],
  ctx: LedgerContext,
  options: LlmRunOptions,
  system: string,
  promptHash: string,
  userText: string,
): Promise<ProviderAnswer> {
  const common = {
    model,
    system,
    prompt: userText,
    maxRetries: 0,
    // The same four fields the SDK forwards to `doGenerate` untouched, under our own namespace;
    // a real provider reads only its own. The fixture provider picks its answer from them.
    providerOptions: {
      hyperfixation: {
        runId: ctx.runId,
        key: options.key,
        promptName: options.prompt,
        promptHash,
      },
    },
    runtimeContext: {
      runId: ctx.runId,
      key: options.key,
      promptName: options.prompt,
      promptHash,
    },
    telemetry: {
      functionId: "llm.run",
      integrations: telemetry,
      includeRuntimeContext: {
        runId: true,
        key: true,
        promptName: true,
        promptHash: true,
      },
    },
  };

  if (options.schema === undefined) {
    const result = await generateText(common);
    return {
      output: { text: result.text },
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    };
  }
  const result = await generateText({
    ...common,
    output: Output.object({ schema: jsonSchema(options.schema), name: options.key }),
  });
  return {
    output: result.output,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
}

/**
 * The gate, one transaction. Its committed `started` row under this attempt's `workflow_id`
 * *is* the reservation — nothing else records it, and an old row re-entering is budget-checked
 * exactly like a fresh one.
 */
async function openGate(ctx: LedgerContext, call: LedgeredCall): Promise<GateOutcome> {
  return ctx.tx(async (db) => {
    const state = await db.execute<{ paused: boolean; period: string }>(sql`
      SELECT COALESCE((SELECT paused FROM hf_app_state WHERE id = 1), false) AS paused,
             to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') AS period
    `);
    const { paused, period } = state.rows[0]!;
    if (paused) throw new AppPaused(ctx.runId, call.key);

    // Created by the first gate of the month from `hf_app_state.budget_usd`; there is no
    // rollover step because the month boundary is a different row.
    await db.execute(sql`
      INSERT INTO hf_budget_period (period, budget_usd)
      SELECT ${period}, budget_usd FROM hf_app_state WHERE id = 1
      ON CONFLICT (period) DO NOTHING
    `);
    // Every gate of the month is serialized from here, which is what makes the reservation
    // below safe to derive rather than to keep as a counter.
    const budget = await db.execute(sql`
      SELECT 1 FROM hf_budget_period WHERE period = ${period} FOR UPDATE
    `);
    if (budget.rowCount === 0) {
      throw new Error(
        `hf_budget_period has no row for ${period} and hf_app_state has none to copy a budget ` +
          "from; the app is not bootstrapped",
      );
    }

    const insert = await db.execute(sql`
      INSERT INTO hf_llm_call
        (run_id, key, workflow_id, period, input_hash, model, prompt_name, prompt_hash, status,
         input, estimated_cost_usd, trace_id)
      VALUES (${ctx.runId}, ${call.key}, ${ctx.workflowId}, ${period}, ${call.inputHash},
              ${call.model}, ${call.promptName}, ${call.promptHash}, 'started',
              ${JSON.stringify(call.input) ?? null}::jsonb, ${call.estimatedCostUsd}::numeric,
              ${call.traceId ?? null})
      ON CONFLICT (run_id, key) DO NOTHING
    `);
    const read = await db.execute<LedgerRow>(sql`
      SELECT status, input_hash, output, period FROM hf_llm_call
      WHERE run_id = ${ctx.runId} AND key = ${call.key}
    `);
    const row = read.rows[0]!;

    if (row.input_hash !== call.inputHash) {
      throw new LedgerKeyCollision(ctx.runId, call.key, row.input_hash, call.inputHash);
    }
    if (row.status === "ok") return { kind: "cached", output: row.output } as const;
    if (row.status === "error") return { kind: "failed", error: storedErrorOf(row) } as const;

    // Only rows a live attempt can still complete count: a dead attempt's row stops reserving
    // at the instant of the bump, and a row on a run that left `running` reserves nothing at
    // all — which is why a failed run cannot starve the budget with an orphan.
    const check = await db.execute<{ reserved: string; exceeded: boolean; budget: string; spent: string }>(sql`
      WITH reserved AS (
        SELECT COALESCE(SUM(l.estimated_cost_usd), 0) AS amount
        FROM hf_llm_call l
        JOIN hf_run r ON r.run_id = l.run_id
        WHERE l.status = 'started'
          AND l.period = ${period}
          AND l.workflow_id = r.current_workflow_id
          AND r.status = 'running'
          AND (l.run_id, l.key) <> (${ctx.runId}, ${call.key})
      )
      SELECT reserved.amount::text AS reserved,
             (b.spent_usd + reserved.amount + ${call.estimatedCostUsd}::numeric > b.budget_usd)
               AS exceeded,
             b.budget_usd::text AS budget,
             b.spent_usd::text AS spent
      FROM hf_budget_period b, reserved
      WHERE b.period = ${period}
    `);
    const { reserved, exceeded, budget: budgetUsd, spent } = check.rows[0]!;
    if (exceeded) {
      // Rolls back, which undoes the insert above; a pre-existing row stays exactly as it was.
      throw new BudgetExceeded(period, budgetUsd, spent, reserved, call.estimatedCostUsd);
    }

    if (insert.rowCount !== 1) {
      // A previous execution crashed between the provider's response and its checkpoint, or the
      // row was abandoned. The provider may have answered and been billed; the flag is the only
      // audit trail there is for that, and a replay never gets to hide it.
      await db.execute(sql`
        UPDATE hf_llm_call
        SET possible_double_charge = true, status = 'started', workflow_id = ${ctx.workflowId},
            period = ${period}, finished_at = NULL, prompt_name = ${call.promptName},
            prompt_hash = ${call.promptHash}, trace_id = ${call.traceId ?? null}
        WHERE run_id = ${ctx.runId} AND key = ${call.key}
      `);
    }
    return { kind: "reserved", period } as const;
  });
}

/**
 * Completion, one transaction: the budget row **before** the ledger row, matching the gate's
 * lock order. The row leaving `started` is what releases its reservation, and the cost lands on
 * the period the row reserved in whatever the clock now says.
 *
 * A `StaleAttempt` from here propagates: the provider call happened, its cost goes unrecorded,
 * and the replaying attempt's `possible_double_charge` is the audit trail.
 */
async function complete(
  ctx: LedgerContext,
  call: LedgeredCall,
  period: string,
  answer: ProviderAnswer,
  costUsd: number,
  latencyMs: number,
): Promise<void> {
  await ctx.tx(async (db) => {
    await db.execute(sql`
      UPDATE hf_budget_period SET spent_usd = spent_usd + ${costUsd}::numeric
      WHERE period = ${period}
    `);
    await db.execute(sql`
      UPDATE hf_llm_call
      SET status = 'ok', output = ${JSON.stringify(answer.output) ?? null}::jsonb,
          tokens_in = ${answer.inputTokens ?? null},
          tokens_out = ${answer.outputTokens ?? null},
          cost_usd = ${costUsd}::numeric, latency_ms = ${latencyMs}, finished_at = now()
      WHERE run_id = ${ctx.runId} AND key = ${call.key}
    `);
  });
}

/** The provider failed: the row records it, nothing is spent, and the error is rethrown. */
async function recordProviderError(
  ctx: LedgerContext,
  call: LedgeredCall,
  error: unknown,
  latencyMs: number,
): Promise<void> {
  const thrown = error as Error | undefined;
  const stored: StoredError = {
    error: { name: thrown?.name ?? "Error", message: thrown?.message ?? String(error) },
  };
  await ctx.tx(async (db) => {
    await db.execute(sql`
      UPDATE hf_llm_call
      SET status = 'error', output = ${JSON.stringify(stored)}::jsonb,
          latency_ms = ${latencyMs}, finished_at = now()
      WHERE run_id = ${ctx.runId} AND key = ${call.key}
    `);
  });
}

function storedErrorOf(row: LedgerRow): Error {
  const stored = (row.output ?? {}) as StoredError;
  const error = new Error(stored.error?.message ?? "the stored hf_llm_call error carried no message");
  error.name = stored.error?.name ?? "Error";
  return error;
}

function userTextOf(input: unknown): string {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  return text ?? "";
}
