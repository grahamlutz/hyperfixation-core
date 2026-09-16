import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Singleton. `budget_usd` is only the default copied into each new hf_budget_period
// row; `month`, `spent_usd` and `reserved_usd` deliberately do not exist — spend
// lives per period in hf_budget_period and the reservation is derived from the
// hf_llm_call rows still in `started`.
export const hfAppState = pgTable(
  "hf_app_state",
  {
    id: integer("id").primaryKey().default(1),
    paused: boolean("paused").notNull().default(false),
    pausedBy: text("paused_by"),
    budgetUsd: numeric("budget_usd", { precision: 12, scale: 4 }).notNull(),
    readTokenHash: text("read_token_hash"),
    writeTokenHash: text("write_token_hash"),
  },
  (t) => [check("hf_app_state_singleton", sql`${t.id} = 1`)],
);

export const hfAudit = pgTable("hf_audit", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  meta: jsonb("meta"),
  at: timestamp("at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});
