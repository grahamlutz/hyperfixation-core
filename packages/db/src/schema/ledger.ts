import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const llmCallStatuses = ["started", "ok", "error", "abandoned"] as const;
export type LlmCallStatus = (typeof llmCallStatuses)[number];

export const actionLogStatuses = ["started", "ok", "failed", "uncertain"] as const;
export type ActionLogStatus = (typeof actionLogStatuses)[number];

export const hfBudgetPeriod = pgTable(
  "hf_budget_period",
  {
    period: text("period").primaryKey(),
    budgetUsd: numeric("budget_usd", { precision: 12, scale: 4 }).notNull(),
    spentUsd: numeric("spent_usd", { precision: 12, scale: 4 }).notNull().default("0"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [check("hf_budget_period_spent_non_negative", sql`${t.spentUsd} >= 0`)],
);

export const hfLlmCall = pgTable(
  "hf_llm_call",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    runId: text("run_id").notNull(),
    key: text("key").notNull(),
    // The attempt that wrote the row: informational once `ok`, load-bearing while
    // `started` because the derived reservation only counts rows whose workflow_id
    // still equals their run's current_workflow_id.
    workflowId: text("workflow_id").notNull(),
    period: text("period").notNull(),
    stepName: text("step_name"),
    promptName: text("prompt_name"),
    promptHash: text("prompt_hash"),
    inputHash: text("input_hash").notNull(),
    model: text("model"),
    status: text("status", { enum: llmCallStatuses }).notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }).notNull(),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    possibleDoubleCharge: boolean("possible_double_charge").notNull().default(false),
    latencyMs: integer("latency_ms"),
    traceId: text("trace_id"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("hf_llm_call_run_key_uq").on(t.runId, t.key),
    // The drift index. The reservation's covering index — (period, run_id,
    // workflow_id) INCLUDE (estimated_cost_usd) WHERE status = 'started' — cannot
    // be declared here: Drizzle has no builder for INCLUDE. It ships as a
    // hand-written migration, and is invisible to `drizzle-kit generate`'s diff
    // because the snapshot never learns about it.
    index("hf_llm_call_period_status_idx").on(t.period, t.status),
  ],
);

export const hfActionLog = pgTable(
  "hf_action_log",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    runId: text("run_id").notNull(),
    key: text("key").notNull(),
    workflowId: text("workflow_id").notNull(),
    channel: text("channel").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", { enum: actionLogStatuses }).notNull(),
    externalId: text("external_id"),
    approvalId: bigint("approval_id", { mode: "number" }),
    recordType: text("record_type"),
    recordId: text("record_id"),
    request: jsonb("request"),
    response: jsonb("response"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [uniqueIndex("hf_action_log_run_key_uq").on(t.runId, t.key)],
);
