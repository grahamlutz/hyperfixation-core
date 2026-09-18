import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const approvalStatuses = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
] as const;
export type ApprovalStatus = (typeof approvalStatuses)[number];

/** Everything that can decide an approval; `sweep` is `reconcile()` step (5) expiring one. */
export const approvalVias = ["web", "telegram", "admin", "archive", "sweep"] as const;
export type ApprovalVia = (typeof approvalVias)[number];

export const hfApproval = pgTable(
  "hf_approval",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    runId: text("run_id").notNull(),
    key: text("key").notNull(),
    // The attempt that created the row. Informational: the decision is fenced by the
    // `hf_run` lock `decide()` takes, not by this column.
    workflowId: text("workflow_id").notNull(),
    type: text("type").notNull(),
    recordType: text("record_type"),
    recordId: text("record_id"),
    draft: jsonb("draft"),
    editedDraft: jsonb("edited_draft"),
    status: text("status", { enum: approvalStatuses }).notNull(),
    assigneeId: text("assignee_id"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
    decidedVia: text("decided_via", { enum: approvalVias }),
    // The replay token: a second `decide()` carrying a key already on the row returns the
    // first one's result and writes nothing.
    decisionKey: text("decision_key"),
    /** The attempt `decide()` enqueued to carry the run on; informational. */
    resumeWorkflowId: text("resume_workflow_id"),
    notifiedAt: timestamp("notified_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    batchId: text("batch_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("hf_approval_run_key_uq").on(t.runId, t.key),
    // The inbox scan and `reconcile()` step (5)'s expiry scan, which both read by status.
    index("hf_approval_status_idx").on(t.status, t.expiresAt),
  ],
);
