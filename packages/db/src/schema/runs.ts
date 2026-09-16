import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const runStatuses = ["running", "waiting", "paused", "done", "failed"] as const;
export type RunStatus = (typeof runStatuses)[number];

export const hfRun = pgTable(
  "hf_run",
  {
    runId: text("run_id").primaryKey(),
    flow: text("flow").notNull(),
    input: jsonb("input"),
    status: text("status", { enum: runStatuses }).notNull(),
    attempt: integer("attempt").notNull().default(1),
    // The fencing token: attempt 1 is `run_id`, attempt N is `run_id:N`. Written
    // only by the one bump path under FOR UPDATE; every step write takes FOR SHARE
    // on this row and matches it.
    currentWorkflowId: text("current_workflow_id").notNull().unique(),
    version: text("version"),
    recordType: text("record_type"),
    recordId: text("record_id"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("hf_run_status_idx").on(t.status),
    index("hf_run_record_idx").on(t.recordType, t.recordId),
    check("hf_run_attempt_positive", sql`${t.attempt} >= 1`),
  ],
);
