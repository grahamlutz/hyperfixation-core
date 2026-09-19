import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  assertNotInWorkflow,
  controlPlaneTx,
  type ApprovalStatus,
  type ApprovalVia,
} from "@hyperfixation/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { prettifyError, type ZodType } from "zod";
import { bumpAndEnqueueOn } from "./bump.js";
import { currentRun } from "./run-context.js";
import { concludeRun } from "./run-status.js";
import { step, type StepContext } from "./step.js";
import { Suspend } from "./suspend.js";
import { workerRuntime } from "./worker-runtime.js";

/** Named in `ControlPlaneInWorkflow` and `CommitLost`. */
export const DECIDE_OPERATION = "approvals.decide";

/** The statuses `decide()` may write; `pending` is the only one it accepts as input. */
export const APPROVAL_DECISIONS = ["approved", "rejected", "expired", "cancelled"] as const;
export type ApprovalDecisionKind = (typeof APPROVAL_DECISIONS)[number];

export interface ApprovalNotice {
  approvalId: number;
  runId: string;
  key: string;
  type: string;
  draft: unknown;
}

export interface WaitForApprovalOptions {
  /** Unique within the run and stable across attempts, exactly as a ledger key is. */
  key: string;
  /** What is being approved; Phase 2 resolves it to a Zod schema for the edited draft. */
  type: string;
  draft?: unknown;
  assigneeId?: string;
  recordType?: string;
  recordId?: string;
  /** From the row's creation; `reconcile()` step (5) expires the row once it is past. */
  expiresInMs?: number;
  /** The minimum slice's whole notification story: whatever the app hands it. */
  notify?(notice: ApprovalNotice): Promise<void>;
}

export interface ApprovalDecision {
  approvalId: number;
  key: string;
  status: Exclude<ApprovalStatus, "pending">;
  /** The edited draft when a decider replaced it, otherwise the one the flow proposed. */
  draft: unknown;
  decidedBy: string | null;
  decidedVia: ApprovalVia | null;
}

interface ApprovalRow extends Record<string, unknown> {
  id: string | number;
  status: ApprovalStatus;
  draft: unknown;
  edited_draft: unknown;
  decided_by: string | null;
  decided_via: ApprovalVia | null;
  notified_at: Date | null;
}

/**
 * The gate a flow opts into. Not a `step()` itself but a pair of them plus a `Suspend`: the
 * throw has to leave from the flow body, because a step that throws has its error checkpointed
 * through `serialize-error` and a replay would revive a plain `Error` that `defineFlow`'s
 * `instanceof Suspend` no longer catches.
 *
 * A decided row returns its decision and the flow carries on — that is how the attempt
 * `decide()` enqueued passes through the gate it stopped at. Everything before this call runs
 * again on that attempt and must be idempotent.
 */
export async function waitForApproval(
  options: WaitForApprovalOptions,
): Promise<ApprovalDecision> {
  const operation = `waitForApproval(${options.key})`;
  const run = currentRun(operation);
  const runtime = workerRuntime(operation);

  const row = await step("approval", (ctx) => createOrRead(ctx, options), { key: options.key });
  if (row.status !== "pending") return decisionOf(row, options.key);

  await step("approval:notify", (ctx) => notify(ctx, options, row), { key: options.key });

  await concludeRun(runtime.control.pool, run.runId, run.workflowId, "waiting", null);
  throw new Suspend(run.runId, "waiting", `approval ${options.key} is pending`);
}

/**
 * Insert and read back in one `ctx.tx`, so the run is locked `FOR SHARE` before `hf_approval`
 * is touched — the same order `decide()` takes them in. `ON CONFLICT DO NOTHING` is what keeps
 * a crash inside this step from orphaning a second row for the same gate.
 */
async function createOrRead(
  ctx: StepContext,
  options: WaitForApprovalOptions,
): Promise<ApprovalRow> {
  return ctx.tx(async (db) => {
    await db.execute(sql`
      INSERT INTO hf_approval
        (run_id, key, workflow_id, type, record_type, record_id, draft, status, assignee_id,
         expires_at)
      VALUES (${ctx.runId}, ${options.key}, ${ctx.workflowId}, ${options.type},
              ${options.recordType ?? null}, ${options.recordId ?? null},
              ${JSON.stringify(options.draft) ?? null}::jsonb, 'pending',
              ${options.assigneeId ?? null},
              ${options.expiresInMs ?? null}::bigint * interval '1 millisecond' + now())
      ON CONFLICT (run_id, key) DO NOTHING
    `);
    const read = await db.execute<ApprovalRow>(sql`
      SELECT id, status, draft, edited_draft, decided_by, decided_via, notified_at
      FROM hf_approval WHERE run_id = ${ctx.runId} AND key = ${options.key}
    `);
    return read.rows[0]!;
  });
}

/** `notified_at` is set after the notifier returned, so a lost notification is retried. */
async function notify(
  ctx: StepContext,
  options: WaitForApprovalOptions,
  row: ApprovalRow,
): Promise<void> {
  if (row.notified_at !== null) return;
  await options.notify?.({
    approvalId: Number(row.id),
    runId: ctx.runId,
    key: options.key,
    type: options.type,
    draft: row.draft,
  });
  await ctx.tx(async (db) => {
    await db.execute(sql`
      UPDATE hf_approval SET notified_at = now()
      WHERE run_id = ${ctx.runId} AND key = ${options.key} AND notified_at IS NULL
    `);
  });
}

function decisionOf(row: ApprovalRow, key: string): ApprovalDecision {
  return {
    approvalId: Number(row.id),
    key,
    status: row.status as Exclude<ApprovalStatus, "pending">,
    draft: row.edited_draft ?? row.draft,
    decidedBy: row.decided_by,
    decidedVia: row.decided_via,
  };
}

/** What an approval type's `schema` has to be: anything zod can `safeParse` an edit with. */
export type ApprovalDraftSchema = ZodType;

export interface DecideOptions {
  ids: number[];
  decision: ApprovalDecisionKind;
  via: ApprovalVia;
  /** The replay token: a second call carrying one already on a row writes nothing. */
  decisionKey: string;
  userId?: string | null;
  /** Per-approval replacement drafts, each parsed against its type's schema before any write. */
  edits?: Record<number, unknown>;
  /**
   * True when the decider holds the admin role, which lets them decide a row assigned to
   * someone else. The caller's session decides that; `decide()` has no idea who is an admin.
   */
  admin?: boolean;
  /**
   * An approval `type` to the schema its edited draft must parse against. Sync and pure — it
   * runs inside the locked transaction. Required whenever `edits` is non-empty; the schemas
   * live in `core`'s registry, which `workflows` cannot import.
   */
  schemaFor?: (type: string) => ApprovalDraftSchema | undefined;
  lockTimeout?: string;
}

export interface DecidedApproval {
  approvalId: number;
  runId: string;
  key: string;
  status: ApprovalDecisionKind;
  /** The attempt this decision enqueued to carry the run on. */
  resumeWorkflowId: string;
}

export interface DecideResult {
  /** True when the batch was already decided under this `decisionKey`; nothing was written. */
  replayed: boolean;
  decided: DecidedApproval[];
  reattempted: { runId: string; attempt: number; workflowId: string }[];
  /** Stamped on every row of a batch of more than one; null for a batch of one. */
  batchId: string | null;
}

export class ApprovalBatchRefused extends Error {
  readonly reasons: { approvalId: number; reason: string }[];

  constructor(reasons: { approvalId: number; reason: string }[]) {
    super(
      `ApprovalBatchRefused: ${reasons
        .map((r) => `${r.approvalId} ${r.reason}`)
        .join("; ")} — the whole batch was rolled back`,
    );
    this.name = "ApprovalBatchRefused";
    this.reasons = reasons;
  }
}

export class ApprovalRunMoved extends Error {
  constructor(approvalId: number) {
    super(
      `ApprovalRunMoved: approval ${approvalId} changed run between the unlocked read that ` +
        "chose which runs to lock and the locked one",
    );
    this.name = "ApprovalRunMoved";
  }
}

export class ApprovalWriteLost extends Error {
  constructor(approvalId: number, rowCount: number) {
    super(
      `ApprovalWriteLost: the conditional update of approval ${approvalId} matched ${rowCount} ` +
        "rows under its own FOR UPDATE lock",
    );
    this.name = "ApprovalWriteLost";
  }
}

const RUN_IDS_STATEMENT = "SELECT id, run_id FROM hf_approval WHERE id = ANY($1::bigint[])";

/**
 * The runs are locked before the approvals and in id order — the order `waitForApproval` takes
 * them in through `ctx.tx`, and the one that stops a step's `INSERT … ON CONFLICT` deadlocking
 * against a decision on the same run (round 3).
 */
const LOCK_RUNS_STATEMENT =
  "SELECT run_id, attempt, current_workflow_id FROM hf_run WHERE run_id = ANY($1::text[]) " +
  "ORDER BY run_id FOR UPDATE";

const LOCK_APPROVALS_STATEMENT =
  "SELECT id, run_id, key, status, decision_key, type, assignee_id, record_type, record_id " +
  "FROM hf_approval WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE";

const DECIDE_STATEMENT =
  "UPDATE hf_approval SET status = $2, decided_by = $3, decided_at = now(), decided_via = $4, " +
  "edited_draft = COALESCE($5::jsonb, edited_draft), decision_key = $6, batch_id = $7 " +
  "WHERE id = $1 AND status = 'pending'";

const RESUME_WORKFLOW_STATEMENT =
  "UPDATE hf_approval SET resume_workflow_id = $2 WHERE id = ANY($1::bigint[])";

const AUDIT_STATEMENT =
  "INSERT INTO hf_audit (actor_id, action, target_type, target_id, meta) " +
  "VALUES ($1, $2, 'hf_approval', $3, $4::jsonb)";

const ACTIVITY_STATEMENT =
  "INSERT INTO hf_activity (record_type, record_id, kind, actor_id, run_id, meta) " +
  "VALUES ($1, $2, $3, $4, NULL, $5::jsonb)";

interface LockedApproval {
  id: string | number;
  run_id: string;
  key: string;
  status: ApprovalStatus;
  decision_key: string | null;
  type: string;
  assignee_id: string | null;
  record_type: string | null;
  record_id: string | null;
}

interface LockedRun {
  run_id: string;
  attempt: number;
  current_workflow_id: string;
}

/**
 * The one way an approval is decided, whoever decides it: the inbox, the admin, a Telegram
 * callback, `records.archive()` and `reconcile()`'s expiry sweep all come through here.
 *
 * A control-plane operation, and one transaction: the decision, the attempt bump and the
 * enqueue of the resume workflow commit together or not at all, so a crash anywhere before the
 * tag-asserted `COMMIT` leaves the approval `pending` and the run untouched, and a retry with
 * the same `decisionKey` starts over. **Nothing in here catches** — a swallowed error would
 * leave the transaction aborted and Postgres would answer `COMMIT` with a `ROLLBACK` tag
 * (round-3 finding 5).
 */
export async function decide(
  pool: Pool,
  dbosClient: DBOSClient,
  options: DecideOptions,
): Promise<DecideResult> {
  assertNotInWorkflow(DECIDE_OPERATION);
  // A caller that hands edits with no way to validate them is a wiring bug, not a refused row.
  if (Object.keys(options.edits ?? {}).length > 0 && options.schemaFor === undefined) {
    throw new TypeError(
      `${DECIDE_OPERATION}: edits were given with no schemaFor; an edited draft is only written ` +
        "once it parses against its approval type's schema",
    );
  }
  try {
    return await decideOnce(pool, dbosClient, options);
  } catch (error) {
    // The read that chose which runs to lock is unlocked by necessity — an approval names its
    // run, not the other way round. Losing that race once is ordinary; twice is not.
    if (!(error instanceof ApprovalRunMoved)) throw error;
    return await decideOnce(pool, dbosClient, options);
  }
}

async function decideOnce(
  pool: Pool,
  dbosClient: DBOSClient,
  options: DecideOptions,
): Promise<DecideResult> {
  const ids = [...new Set(options.ids)].sort((a, b) => a - b);
  const lockTimeout = options.lockTimeout === undefined ? {} : { lockTimeout: options.lockTimeout };

  return controlPlaneTx(pool, { operation: DECIDE_OPERATION, ...lockTimeout }, async (client) => {
    const scouted = await client.query<{ id: string; run_id: string }>(RUN_IDS_STATEMENT, [ids]);
    const runIds = [...new Set(scouted.rows.map((row) => row.run_id))].sort();

    const runs = await client.query<LockedRun>(LOCK_RUNS_STATEMENT, [runIds]);
    const locked = await client.query<LockedApproval>(LOCK_APPROVALS_STATEMENT, [ids]);
    for (const row of locked.rows) {
      if (!runIds.includes(row.run_id)) throw new ApprovalRunMoved(Number(row.id));
    }
    const byId = new Map(locked.rows.map((row) => [Number(row.id), row]));

    const replay = locked.rows.filter((row) => row.decision_key === options.decisionKey);
    if (replay.length > 0) {
      if (replay.length !== locked.rows.length) {
        throw new ApprovalBatchRefused(
          locked.rows
            .filter((row) => row.decision_key !== options.decisionKey)
            .map((row) => ({
              approvalId: Number(row.id),
              reason: `was not part of the batch decided under ${options.decisionKey}`,
            })),
        );
      }
      return replayed(client, locked.rows, runs.rows);
    }

    const parsed = assertDecidable(ids, locked.rows, options);
    // One id is one row; a batch id would only name a batch of it.
    const batchId = ids.length > 1 ? randomUUID() : null;

    for (const row of locked.rows) {
      const id = Number(row.id);
      const written = await client.query(DECIDE_STATEMENT, [
        row.id,
        options.decision,
        options.userId ?? null,
        options.via,
        parsed.has(id) ? JSON.stringify(parsed.get(id)) : null,
        options.decisionKey,
        batchId,
      ]);
      if (written.rowCount !== 1) throw new ApprovalWriteLost(Number(row.id), written.rowCount ?? 0);
    }

    const decided: DecidedApproval[] = [];
    const reattempted: DecideResult["reattempted"] = [];
    for (const runId of runIds) {
      const bumped = await bumpAndEnqueueOn(client, dbosClient, runId);
      reattempted.push({
        runId,
        attempt: bumped.attempt,
        workflowId: bumped.workflowId,
      });
      const theirs = locked.rows.filter((row) => row.run_id === runId);
      await client.query(RESUME_WORKFLOW_STATEMENT, [
        theirs.map((row) => row.id),
        bumped.workflowId,
      ]);
      for (const row of theirs) {
        decided.push({
          approvalId: Number(row.id),
          runId,
          key: row.key,
          status: options.decision,
          resumeWorkflowId: bumped.workflowId,
        });
      }
    }

    // Fatal by construction: an audit row this transaction could not write is a decision with
    // no record of who made it, and there is no catch anywhere for it to be demoted by.
    for (const row of decided) {
      const meta = JSON.stringify({
        runId: row.runId,
        key: row.key,
        via: options.via,
        decisionKey: options.decisionKey,
        batchId,
        resumeWorkflowId: row.resumeWorkflowId,
      });
      await client.query(AUDIT_STATEMENT, [
        options.userId ?? null,
        `approval.${options.decision}`,
        String(row.approvalId),
        meta,
      ]);
      // Last, because `hf_activity` is in the last lock tier and every `hf_approval` write is
      // already behind us. Fatal under the same rule as the audit row above.
      const target = byId.get(row.approvalId)!;
      await client.query(ACTIVITY_STATEMENT, [
        target.record_type ?? "hf_approval",
        target.record_id ?? String(row.approvalId),
        `approval.${options.decision}`,
        options.userId ?? null,
        meta,
      ]);
    }

    return { replayed: false, decided, reattempted, batchId };
  });
}

/**
 * Every reason the batch is refused, gathered in one pass before anything is written, and the
 * parsed edits the write then stores — what the schema returned, not what the caller sent.
 */
function assertDecidable(
  ids: number[],
  locked: LockedApproval[],
  options: DecideOptions,
): Map<number, unknown> {
  const reasons: { approvalId: number; reason: string }[] = [];
  const parsed = new Map<number, unknown>();
  const found = new Set(locked.map((row) => Number(row.id)));
  for (const id of ids) {
    if (!found.has(id)) reasons.push({ approvalId: id, reason: "has no hf_approval row" });
  }
  // `archive` and `sweep` carry no human decider — the record went, or the row timed out — so
  // the assignee rule would only stop an assigned row from ever being cancelled or expired.
  const humanDecision = options.via !== "archive" && options.via !== "sweep";
  for (const row of locked) {
    const id = Number(row.id);
    if (row.status !== "pending") {
      reasons.push({ approvalId: id, reason: `is already ${row.status}` });
    }
    if (
      humanDecision &&
      row.assignee_id !== null &&
      row.assignee_id !== options.userId &&
      options.admin !== true
    ) {
      reasons.push({ approvalId: id, reason: `is assigned to ${row.assignee_id}` });
    }
    const edit = options.edits?.[id];
    if (edit === undefined) continue;
    const schema = options.schemaFor?.(row.type);
    if (schema === undefined) {
      reasons.push({
        approvalId: id,
        reason: `has an edit but type ${row.type} has no registered schema`,
      });
      continue;
    }
    const result = schema.safeParse(edit);
    if (!result.success) {
      reasons.push({
        approvalId: id,
        reason: `has an edit that does not match schema for type ${row.type}: ${prettifyError(result.error)}`,
      });
      continue;
    }
    parsed.set(id, result.data);
  }
  if (reasons.length > 0) throw new ApprovalBatchRefused(reasons);
  return parsed;
}

/**
 * What the transaction that first carried this `decisionKey` returned, read back rather than
 * recomputed: the resume workflow it enqueued is on the rows it wrote.
 */
async function replayed(
  client: PoolClient,
  locked: LockedApproval[],
  runs: LockedRun[],
): Promise<DecideResult> {
  const { rows } = await client.query<{
    id: string;
    run_id: string;
    key: string;
    status: ApprovalDecisionKind;
    resume_workflow_id: string | null;
    batch_id: string | null;
  }>(
    "SELECT id, run_id, key, status, resume_workflow_id, batch_id FROM hf_approval WHERE id = ANY($1::bigint[]) ORDER BY id",
    [locked.map((row) => row.id)],
  );
  return {
    replayed: true,
    batchId: rows[0]?.batch_id ?? null,
    decided: rows.map((row) => ({
      approvalId: Number(row.id),
      runId: row.run_id,
      key: row.key,
      status: row.status,
      resumeWorkflowId: row.resume_workflow_id ?? "",
    })),
    reattempted: runs.map((run) => ({
      runId: run.run_id,
      attempt: Number(run.attempt),
      workflowId: run.current_workflow_id,
    })),
  };
}

export const approvals = { decide, waitForApproval };
