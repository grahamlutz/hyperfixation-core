import type {
  JSONSchema7,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import type { StepDatabase } from "@hyperfixation/db";
import { sql } from "drizzle-orm";
import { AppPaused, BudgetExceeded, LedgerKeyCollision } from "./errors.js";
import { hashInput } from "./input-hash.js";

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
  /** The system instruction. Phase 2 replaces it with a prompt file addressed by content hash. */
  prompt: string;
  input: unknown;
  /** When set, the call asks for JSON and the answer is parsed rather than returned as text. */
  schema?: JSONSchema7;
  /** TEMPORARY (chunk 10): Phase 2's provider registry estimates this from the model and input. */
  estimatedCostUsd: number;
  /** TEMPORARY (chunk 10): Phase 2 computes the billed cost from the model and returned tokens. */
  costUsd?: number;
  /** Phase 2 resolves this from the provider registry by name. */
  model: LanguageModelV4;
}

type GateOutcome =
  | { kind: "reserved"; period: string }
  | { kind: "cached"; output: unknown }
  | { kind: "failed"; error: Error };

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
export async function run<O = { text: string }>(
  ctx: LedgerContext,
  options: LlmRunOptions,
): Promise<O> {
  const inputHash = hashInput(options.input);

  const gate = await openGate(ctx, options, inputHash);
  if (gate.kind === "cached") return gate.output as O;
  // Committed before it is thrown: a failed call is not retried by replay, so the row that
  // records the failure has to outlive this attempt just as an `ok` row does.
  if (gate.kind === "failed") throw gate.error;

  const startedAt = Date.now();
  let result: LanguageModelV4GenerateResult;
  try {
    result = await options.model.doGenerate(callOptions(options));
  } catch (error) {
    await recordProviderError(ctx, options, error, Date.now() - startedAt);
    throw error;
  }

  const output = parseOutput(result, options.schema);
  await complete(ctx, options, gate.period, result, output, Date.now() - startedAt);
  return output as O;
}

/** `llm.run(…)`, the name the plan and every flow use. */
export const llm = { run };

/**
 * The gate, one transaction. Its committed `started` row under this attempt's `workflow_id`
 * *is* the reservation — nothing else records it, and an old row re-entering is budget-checked
 * exactly like a fresh one.
 */
async function openGate(
  ctx: LedgerContext,
  options: LlmRunOptions,
  inputHash: string,
): Promise<GateOutcome> {
  return ctx.tx(async (db) => {
    const state = await db.execute<{ paused: boolean; period: string }>(sql`
      SELECT COALESCE((SELECT paused FROM hf_app_state WHERE id = 1), false) AS paused,
             to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') AS period
    `);
    const { paused, period } = state.rows[0]!;
    if (paused) throw new AppPaused(ctx.runId, options.key);

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
        (run_id, key, workflow_id, period, input_hash, model, status, input, estimated_cost_usd)
      VALUES (${ctx.runId}, ${options.key}, ${ctx.workflowId}, ${period}, ${inputHash},
              ${options.model.modelId}, 'started', ${JSON.stringify(options.input) ?? null}::jsonb,
              ${options.estimatedCostUsd}::numeric)
      ON CONFLICT (run_id, key) DO NOTHING
    `);
    const read = await db.execute<LedgerRow>(sql`
      SELECT status, input_hash, output, period FROM hf_llm_call
      WHERE run_id = ${ctx.runId} AND key = ${options.key}
    `);
    const row = read.rows[0]!;

    if (row.input_hash !== inputHash) {
      throw new LedgerKeyCollision(ctx.runId, options.key, row.input_hash, inputHash);
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
          AND (l.run_id, l.key) <> (${ctx.runId}, ${options.key})
      )
      SELECT reserved.amount::text AS reserved,
             (b.spent_usd + reserved.amount + ${options.estimatedCostUsd}::numeric > b.budget_usd)
               AS exceeded,
             b.budget_usd::text AS budget,
             b.spent_usd::text AS spent
      FROM hf_budget_period b, reserved
      WHERE b.period = ${period}
    `);
    const { reserved, exceeded, budget: budgetUsd, spent } = check.rows[0]!;
    if (exceeded) {
      // Rolls back, which undoes the insert above; a pre-existing row stays exactly as it was.
      throw new BudgetExceeded(period, budgetUsd, spent, reserved, options.estimatedCostUsd);
    }

    if (insert.rowCount !== 1) {
      // A previous execution crashed between the provider's response and its checkpoint, or the
      // row was abandoned. The provider may have answered and been billed; the flag is the only
      // audit trail there is for that, and a replay never gets to hide it.
      await db.execute(sql`
        UPDATE hf_llm_call
        SET possible_double_charge = true, status = 'started', workflow_id = ${ctx.workflowId},
            period = ${period}, finished_at = NULL
        WHERE run_id = ${ctx.runId} AND key = ${options.key}
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
  options: LlmRunOptions,
  period: string,
  result: LanguageModelV4GenerateResult,
  output: unknown,
  latencyMs: number,
): Promise<void> {
  const costUsd = options.costUsd ?? options.estimatedCostUsd;
  await ctx.tx(async (db) => {
    await db.execute(sql`
      UPDATE hf_budget_period SET spent_usd = spent_usd + ${costUsd}::numeric
      WHERE period = ${period}
    `);
    await db.execute(sql`
      UPDATE hf_llm_call
      SET status = 'ok', output = ${JSON.stringify(output) ?? null}::jsonb,
          tokens_in = ${result.usage.inputTokens.total ?? null},
          tokens_out = ${result.usage.outputTokens.total ?? null},
          cost_usd = ${costUsd}::numeric, latency_ms = ${latencyMs}, finished_at = now()
      WHERE run_id = ${ctx.runId} AND key = ${options.key}
    `);
  });
}

/** The provider failed: the row records it, nothing is spent, and the error is rethrown. */
async function recordProviderError(
  ctx: LedgerContext,
  options: LlmRunOptions,
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
      WHERE run_id = ${ctx.runId} AND key = ${options.key}
    `);
  });
}

function storedErrorOf(row: LedgerRow): Error {
  const stored = (row.output ?? {}) as StoredError;
  const error = new Error(stored.error?.message ?? "the stored hf_llm_call error carried no message");
  error.name = stored.error?.name ?? "Error";
  return error;
}

function callOptions(options: LlmRunOptions): LanguageModelV4CallOptions {
  const text = typeof options.input === "string" ? options.input : JSON.stringify(options.input);
  return {
    prompt: [
      { role: "system", content: options.prompt },
      { role: "user", content: [{ type: "text", text: text ?? "" }] },
    ],
    ...(options.schema === undefined
      ? {}
      : { responseFormat: { type: "json" as const, schema: options.schema, name: options.key } }),
  };
}

function parseOutput(
  result: LanguageModelV4GenerateResult,
  schema: JSONSchema7 | undefined,
): unknown {
  const text = result.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
  return schema === undefined ? { text } : (JSON.parse(text) as unknown);
}
