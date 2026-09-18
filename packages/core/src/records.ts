import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  assertNotInWorkflow,
  controlPlaneTx,
  quoteIdent,
  type RecordTable,
} from "@hyperfixation/db";
import { decide } from "@hyperfixation/workflows";
import type { Pool } from "pg";
import type { Registry } from "./registry.js";

export const ARCHIVE_OPERATION = "records.archive";

/** One line per record archived, carrying what it took down with it. */
export const ARCHIVED_MARKER = "hf-records: archived";

/**
 * Pending approvals on the record being archived. Read unlocked — `decide()` locks what it
 * decides, and an approval someone decided between this read and that lock is simply not
 * pending by then and refuses the batch, which is the right answer.
 */
const PENDING_FOR_RECORD_STATEMENT =
  "SELECT id FROM hf_approval WHERE record_type = $1 AND record_id = $2 AND status = 'pending' " +
  "ORDER BY id";

const AUDIT_STATEMENT =
  "INSERT INTO hf_audit (actor_id, action, target_type, target_id, meta) VALUES ($1, 'record.archived', $2, $3, $4::jsonb)";

export interface ArchiveOptions {
  recordType: string;
  recordId: string | number;
  userId?: string | null;
  reason?: string;
}

export interface ArchiveResult {
  recordType: string;
  recordId: string;
  /** False when the record was already archived; archiving twice writes nothing the second time. */
  archived: boolean;
  /** The approvals this archive cancelled, each through `decide()` and its own bump. */
  cancelledApprovals: number[];
}

/** Stable per approval, so an archive retried after a crash replays instead of deciding twice. */
export function archiveDecisionKey(
  recordType: string,
  recordId: string,
  approvalId: number,
): string {
  return `archive:${recordType}:${recordId}:${approvalId}`;
}

/**
 * A **control-plane operation**, and the reason `assertNotInWorkflow()` exists at all
 * (round-3 finding 2): called from inside a step's open `ctx.tx` on the same run, the
 * `FOR UPDATE` this takes on `hf_run` through `decide()` would wait on the step's own
 * `FOR SHARE` while the step waits on this call — a cycle whose second half is a JS `await`,
 * which Postgres's deadlock detector cannot see. So it is refused from inside any run, before
 * a single statement is issued. A flow that wants a record archived creates a task.
 *
 * The approvals go first and the record second: cancelling an approval bumps its run, so the
 * flow waiting on it resumes and sees the cancellation rather than the record vanishing
 * underneath it. Each approval is its own `decide()` call — a batch would let one bad row
 * strand the rest — and each carries a `decisionKey` derived from the record, so an archive
 * retried after a crash replays the decisions it already made.
 */
export async function archiveRecord(
  pool: Pool,
  client: DBOSClient,
  records: Registry<RecordTable>,
  options: ArchiveOptions,
): Promise<ArchiveResult> {
  assertNotInWorkflow(ARCHIVE_OPERATION);

  const recordId = String(options.recordId);
  const { table } = records.require(options.recordType);

  const pending = await pool.query<{ id: string }>(PENDING_FOR_RECORD_STATEMENT, [
    options.recordType,
    recordId,
  ]);
  const cancelledApprovals: number[] = [];
  for (const row of pending.rows) {
    const approvalId = Number(row.id);
    const result = await decide(pool, client, {
      ids: [approvalId],
      decision: "cancelled",
      via: "archive",
      decisionKey: archiveDecisionKey(options.recordType, recordId, approvalId),
      userId: options.userId ?? null,
    });
    cancelledApprovals.push(...result.decided.map((decided) => decided.approvalId));
  }

  const archived = await controlPlaneTx(pool, { operation: ARCHIVE_OPERATION }, async (work) => {
    // `archived_at` is the record mixin's column; a table registered as a record type without
    // it fails here by name rather than by being quietly skipped.
    const updated = await work.query(
      `UPDATE ${quoteIdent(table)} SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`,
      [recordId],
    );
    await work.query(AUDIT_STATEMENT, [
      options.userId ?? null,
      options.recordType,
      recordId,
      JSON.stringify({
        table,
        reason: options.reason ?? null,
        cancelledApprovals,
        alreadyArchived: updated.rowCount === 0,
      }),
    ]);
    return updated.rowCount === 1;
  });

  const result: ArchiveResult = {
    recordType: options.recordType,
    recordId,
    archived,
    cancelledApprovals,
  };
  console.info(ARCHIVED_MARKER, JSON.stringify(result));
  return result;
}
