import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  assertNotInWorkflow,
  controlPlaneTx,
  quoteIdent,
  type RecordTable,
} from "@hyperfixation/db";
import { decide } from "@hyperfixation/workflows";
import type { Pool } from "pg";
import { insertActivity } from "./activity.js";
import { InvalidDefinition, type Registry } from "./registry.js";
import { cancelOpenTasksForRecord } from "./tasks.js";

export const ARCHIVE_OPERATION = "records.archive";

/** The `displayColumn` a record type gets when it names none: the mixin's own name column. */
export const DEFAULT_DISPLAY_COLUMN = "normalized_name";

/** One board column. `name` is the value the mixin's `stage` carries; `title` is the heading. */
export interface StageDefinition {
  readonly name: string;
  readonly title: string;
}

/**
 * What the workspace needs to know about a record type, on top of the two strings the delete
 * guard and every machinery row already need. All of it is optional: a bare `RecordTable` is
 * still a valid registration, and the workspace falls back to `recordType` and
 * `DEFAULT_DISPLAY_COLUMN`.
 */
export interface RecordDefinition extends RecordTable {
  /** What the nav and the board call this type; `recordType` when absent. */
  readonly title?: string;
  /** The column the workspace shows as a record's name. */
  readonly displayColumn?: string;
  /** The board's columns, in board order. A `stage` outside the list gets an "Other" column. */
  readonly stages?: readonly StageDefinition[];
}

export function displayColumnOf(definition: RecordDefinition): string {
  return definition.displayColumn ?? DEFAULT_DISPLAY_COLUMN;
}

/**
 * Refused at registration rather than at render: a duplicate stage name would give the board two
 * columns competing for the same rows, and which one won would depend on iteration order.
 */
export function assertRecordStages(definition: RecordDefinition): void {
  const seen = new Set<string>();
  for (const stage of definition.stages ?? []) {
    if (seen.has(stage.name)) {
      throw new InvalidDefinition(
        "record type",
        definition.recordType,
        `lists the stage ${JSON.stringify(stage.name)} twice`,
      );
    }
    seen.add(stage.name);
  }
}

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
  /** The record's open tasks, cancelled in the same transaction as the record itself. */
  cancelledTasks: number[];
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

  // The tasks go with the record and nothing else does: `hf_activity`, `hf_label` and
  // `hf_outcome` are the record's history, and archiving is not a deletion.
  const { archived, cancelledTasks } = await controlPlaneTx(
    pool,
    { operation: ARCHIVE_OPERATION },
    async (work) => {
      // `archived_at` is the record mixin's column; a table registered as a record type without
      // it fails here by name rather than by being quietly skipped.
      const updated = await work.query(
        `UPDATE ${quoteIdent(table)} SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`,
        [recordId],
      );
      const cancelled = await cancelOpenTasksForRecord(work, options.recordType, recordId);
      const meta = {
        table,
        reason: options.reason ?? null,
        cancelledApprovals,
        cancelledTasks: cancelled,
        alreadyArchived: updated.rowCount === 0,
      };
      await insertActivity(work, {
        recordType: options.recordType,
        recordId,
        kind: "record.archived",
        actorId: options.userId ?? null,
        meta,
      });
      await work.query(AUDIT_STATEMENT, [
        options.userId ?? null,
        options.recordType,
        recordId,
        JSON.stringify(meta),
      ]);
      return { archived: updated.rowCount === 1, cancelledTasks: cancelled };
    },
  );

  const result: ArchiveResult = {
    recordType: options.recordType,
    recordId,
    archived,
    cancelledApprovals,
    cancelledTasks,
  };
  console.info(ARCHIVED_MARKER, JSON.stringify(result));
  return result;
}
