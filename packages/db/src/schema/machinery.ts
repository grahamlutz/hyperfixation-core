import { sql } from "drizzle-orm";
import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// None of these tables carries a foreign key to an app table (E004 applies the other way
// round, but the core cannot know an app's tables either), and every `record_id` is `text`
// — a record id is carried, not joined on, matching hf_approval and hf_action_log.
// Lock order: all of them sit in the last tier, with the app's own tables.

export const sourceRunStatuses = ["running", "ok", "error"] as const;
export type SourceRunStatus = (typeof sourceRunStatuses)[number];

export const sourceRecordStatuses = ["new", "linked", "review", "error"] as const;
export type SourceRecordStatus = (typeof sourceRecordStatuses)[number];

export const recordLinkMethods = ["exact", "fuzzy", "manual", "human_confirmed"] as const;
export type RecordLinkMethod = (typeof recordLinkMethods)[number];

export const taskOrigins = ["flow", "manual", "sweep"] as const;
export type TaskOrigin = (typeof taskOrigins)[number];

export const labelTargets = ["score", "draft", "record"] as const;
export type LabelTarget = (typeof labelTargets)[number];

export const labelValues = ["up", "down", "correction"] as const;
export type LabelValue = (typeof labelValues)[number];

const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const id = () => bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey();

export const hfSourceRun = pgTable("hf_source_run", {
  id: id(),
  source: text("source").notNull(),
  startedAt: at("started_at").notNull().defaultNow(),
  finishedAt: at("finished_at"),
  status: text("status", { enum: sourceRunStatuses }).notNull(),
  rowsIn: integer("rows_in").notNull().default(0),
  rowsNew: integer("rows_new").notNull().default(0),
  rowsChanged: integer("rows_changed").notNull().default(0),
  error: text("error"),
});

export const hfSourceRecord = pgTable(
  "hf_source_record",
  {
    id: id(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status", { enum: sourceRecordStatuses }).notNull().default("new"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    runId: bigint("run_id", { mode: "number" }),
    firstSeen: at("first_seen").notNull().defaultNow(),
    lastSeen: at("last_seen").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("hf_source_record_source_external_uq").on(t.source, t.externalId),
    // The resolver's batch scan: what is still `new` or waiting in `review`.
    index("hf_source_record_status_idx").on(t.status),
  ],
);

export const hfRecordLink = pgTable(
  "hf_record_link",
  {
    id: id(),
    sourceRecordId: bigint("source_record_id", { mode: "number" }).notNull(),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    confidence: doublePrecision("confidence"),
    method: text("method", { enum: recordLinkMethods }).notNull(),
    decidedBy: text("decided_by"),
    decidedAt: at("decided_at"),
  },
  (t) => [
    uniqueIndex("hf_record_link_source_record_uq").on(t.sourceRecordId),
    index("hf_record_link_record_idx").on(t.recordType, t.recordId),
  ],
);

export const hfScore = pgTable(
  "hf_score",
  {
    id: id(),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    specVersion: integer("spec_version").notNull(),
    score: doublePrecision("score").notNull(),
    explanation: text("explanation"),
    // The ledger row of the call that produced an LLM-assigned score; a rule-based score has none.
    llmCallId: bigint("llm_call_id", { mode: "number" }),
    // What makes a step-side score write replay-safe: attempt 2 runs the step again under a new
    // workflow id, and `(run_id, key)` is what it conflicts on. Null for a web-side write.
    runId: text("run_id"),
    key: text("key"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("hf_score_record_idx").on(t.recordType, t.recordId),
    uniqueIndex("hf_score_run_key_uq")
      .on(t.runId, t.key)
      .where(sql`${t.key} IS NOT NULL`),
  ],
);

export const hfActivity = pgTable(
  "hf_activity",
  {
    id: id(),
    // Nullable, like `hf_approval`'s and `hf_action_log`'s: a row about no record writes NULL,
    // which E002 ignores. A stand-in such as `'hf_approval'` would fail it at the next boot.
    recordType: text("record_type"),
    recordId: text("record_id"),
    kind: text("kind").notNull(),
    actorId: text("actor_id"),
    body: text("body"),
    meta: jsonb("meta"),
    // The run that wrote it, for the timeline; null for a web-side write (a label, an
    // outcome, a manual task), which the timeline groups under "manual".
    runId: text("run_id"),
    // The idempotency key of the step that wrote it; null for a web-side write, which happens
    // once per request and has no replay to survive.
    key: text("key"),
    at: at("at").notNull().defaultNow(),
  },
  (t) => [
    index("hf_activity_record_idx").on(t.recordType, t.recordId),
    uniqueIndex("hf_activity_run_key_uq")
      .on(t.runId, t.key)
      .where(sql`${t.key} IS NOT NULL`),
  ],
);

export const hfTask = pgTable(
  "hf_task",
  {
    id: id(),
    // Nullable for the same reason as `hf_activity`'s above.
    recordType: text("record_type"),
    recordId: text("record_id"),
    title: text("title").notNull(),
    dueAt: at("due_at"),
    ownerId: text("owner_id"),
    doneAt: at("done_at"),
    cancelledAt: at("cancelled_at"),
    origin: text("origin", { enum: taskOrigins }).notNull(),
    // Makes "one task per uncertain action row, once" an `ON CONFLICT` target for
    // `reconcile()` and `actions.perform`; set to the action-log row's id.
    originRef: text("origin_ref"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("hf_task_record_idx").on(t.recordType, t.recordId),
    uniqueIndex("hf_task_origin_ref_uq")
      .on(t.origin, t.originRef)
      .where(sql`${t.originRef} IS NOT NULL`),
  ],
);

export const hfLabel = pgTable(
  "hf_label",
  {
    id: id(),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    target: text("target", { enum: labelTargets }).notNull(),
    targetId: text("target_id"),
    value: text("value", { enum: labelValues }).notNull(),
    correction: jsonb("correction"),
    userId: text("user_id"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [index("hf_label_record_idx").on(t.recordType, t.recordId)],
);

export const hfOutcome = pgTable(
  "hf_outcome",
  {
    id: id(),
    recordType: text("record_type").notNull(),
    recordId: text("record_id").notNull(),
    outcome: text("outcome").notNull(),
    at: at("at").notNull().defaultNow(),
    notes: text("notes"),
  },
  (t) => [index("hf_outcome_record_idx").on(t.recordType, t.recordId)],
);
