/**
 * What the workspace reads. Every function here is a control-plane read on the attached pool —
 * plain unlocked SELECTs over the machinery tables and the app's own record table, no lock and
 * no write — and every one is refused from inside a run for the reason `records.archive()`
 * gives: a control-plane pool call made under a step's open transaction is a wait no deadlock
 * detector can see.
 *
 * The views live here and not in `workspace.ts` because that file is the framework-light
 * subpath the template imports: it stays pure and synchronous, and only the types cross over.
 */

import { assertNotInWorkflow, quoteIdent } from "@hyperfixation/db";
import type { ApprovalDecisionKind, DecideResult } from "@hyperfixation/workflows";
import type { Pool } from "pg";
import { listActivity, type ActivityRow } from "./activity.js";
import { listLabels, type LabelRow } from "./labels.js";
import { listOutcomes, type OutcomeRow } from "./outcomes.js";
import { displayColumnOf, type RecordDefinition, type StageDefinition } from "./records.js";
import type { Registry } from "./registry.js";
import { taskRowOf, TASK_COLUMNS, type TaskQueryRow, type TaskRow } from "./tasks.js";
import { DEFAULT_BOARD_LIMIT, draftFields, type DraftField } from "./workspace.js";

export { DEFAULT_BOARD_LIMIT };

export const WORKSPACE_INBOX_OPERATION = "workspace.inbox";
export const WORKSPACE_HOME_OPERATION = "workspace.home";
export const WORKSPACE_BOARD_OPERATION = "workspace.board";
export const WORKSPACE_RECORD_OPERATION = "workspace.record";

/**
 * The run is joined, not looked up per row: an approval's `run_id` is NOT NULL and its row is
 * written inside the run's own transaction, so an approval with no `hf_run` row does not exist.
 */
const INBOX_STATEMENT =
  "SELECT a.id, a.run_id, r.flow, a.key, a.type, a.record_type, a.record_id, a.assignee_id, " +
  "a.created_at, a.expires_at, a.draft FROM hf_approval a JOIN hf_run r ON r.run_id = a.run_id " +
  "WHERE a.status = 'pending' " +
  "AND ($1::boolean OR a.assignee_id IS NULL OR a.assignee_id = $2) " +
  "AND ($3::text IS NULL OR (a.record_type = $3 AND a.record_id = $4)) " +
  "ORDER BY a.created_at, a.id";

const HOME_TASKS_STATEMENT =
  `SELECT ${TASK_COLUMNS} FROM hf_task WHERE done_at IS NULL AND cancelled_at IS NULL ` +
  "AND (owner_id IS NULL OR owner_id = $1) ORDER BY due_at NULLS LAST, id";

const REVIEW_QUEUE_STATEMENT =
  "SELECT source, count(*)::int AS count FROM hf_source_record WHERE status = 'review' " +
  "GROUP BY source ORDER BY source";

const RUNS_STATEMENT = "SELECT run_id, flow, started_at FROM hf_run WHERE run_id = ANY($1::text[])";

interface InboxQueryRow {
  id: string;
  run_id: string;
  flow: string;
  key: string;
  type: string;
  record_type: string | null;
  record_id: string | null;
  assignee_id: string | null;
  created_at: Date;
  expires_at: Date | null;
  draft: unknown;
}

/** The handles and registries every view reads through; `defineApp` supplies them. */
export interface WorkspaceViewDeps {
  pool: Pool;
  records: Registry<RecordDefinition>;
  /** True for an approval type with a registered draft schema — the only kind an edit reaches. */
  hasSchema(type: string): boolean;
}

/** One pending approval, with its draft already flattened for whatever renders it. */
export interface InboxItem {
  approvalId: number;
  runId: string;
  flow: string;
  key: string;
  type: string;
  recordType: string | null;
  recordId: string | null;
  /** The record's `displayColumn`; null when the approval names no record or the row is gone. */
  recordTitle: string | null;
  assigneeId: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  draft: unknown;
  fields: DraftField[];
  /** False when the approval's type registers no schema, which is what refuses every edit. */
  editable: boolean;
}

export interface InboxOptions {
  userId: string;
  /** An admin sees every pending approval, not only their own and the unassigned ones. */
  admin?: boolean;
}

export interface InboxView {
  items: InboxItem[];
  /** Counted over what this call returned, so an admin's counts are still their own. */
  mine: number;
  unassigned: number;
}

export interface HomeOptions {
  userId: string;
}

export interface ReviewQueueCount {
  source: string;
  count: number;
}

export interface HomeView {
  /** The user's own and the unassigned pending approvals — never someone else's. */
  approvals: InboxItem[];
  tasks: TaskRow[];
  reviewQueue: ReviewQueueCount[];
}

export interface BoardOptions {
  limit?: number;
}

export interface BoardCard {
  id: string;
  title: string | null;
  stage: string | null;
  score: number | null;
  updatedAt: Date | null;
}

export interface BoardColumn {
  stage: StageDefinition;
  cards: BoardCard[];
}

export interface BoardView {
  record: RecordDefinition;
  columns: BoardColumn[];
  /** Cards whose `stage` is null or names no registered stage. */
  other: BoardCard[];
  /** The limit this read used, whether the caller gave one or not. */
  limit: number;
  /** True when the table holds more unarchived rows than `limit` returned. */
  truncated: boolean;
}

/** One run's writes on a record, in order. `runId` null is the manual group. */
export interface TimelineGroup {
  runId: string | null;
  flow: string | null;
  startedAt: Date | null;
  entries: ActivityRow[];
}

export interface RecordView {
  record: RecordDefinition;
  id: string;
  title: string | null;
  /** The app table's own row, column names as the table spells them. */
  row: Record<string, unknown>;
  archivedAt: Date | null;
  timeline: TimelineGroup[];
  labels: LabelRow[];
  outcomes: OutcomeRow[];
  tasks: TaskRow[];
  pendingApprovals: InboxItem[];
}

/** `DecideOptions` without `via`: the workspace is the web, and only the web. */
export interface WorkspaceDecideOptions {
  ids: number[];
  decision: ApprovalDecisionKind;
  /** Per-approval replacement drafts, parsed against the type's schema by `decide()`. */
  edits?: Record<number, unknown>;
  /** The client's own token, generated once per form mount, so a double submit replays. */
  decisionKey: string;
  userId?: string | null;
  /** Whether the session holds the admin role; without it an assigned row refuses. */
  admin?: boolean;
}

/** The reads `app.workspace` adds to the descriptors; all of them control-plane. */
export interface WorkspaceViews {
  inbox(options: InboxOptions): Promise<InboxView>;
  home(options: HomeOptions): Promise<HomeView>;
  board(recordType: string, options?: BoardOptions): Promise<BoardView>;
  /** Undefined when the table holds no row with that id; an archived record still resolves. */
  record(recordType: string, id: string | number): Promise<RecordView | undefined>;
  decide(options: WorkspaceDecideOptions): Promise<DecideResult>;
}

export async function workspaceInbox(
  deps: WorkspaceViewDeps,
  options: InboxOptions,
): Promise<InboxView> {
  assertNotInWorkflow(WORKSPACE_INBOX_OPERATION);
  const items = await pendingApprovals(deps, {
    admin: options.admin === true,
    userId: options.userId,
  });
  return {
    items,
    mine: items.filter((item) => item.assigneeId !== null && item.assigneeId === options.userId)
      .length,
    unassigned: items.filter((item) => item.assigneeId === null).length,
  };
}

export async function workspaceHome(
  deps: WorkspaceViewDeps,
  options: HomeOptions,
): Promise<HomeView> {
  assertNotInWorkflow(WORKSPACE_HOME_OPERATION);
  const approvals = await pendingApprovals(deps, { admin: false, userId: options.userId });
  const tasks = await deps.pool.query<TaskQueryRow>(HOME_TASKS_STATEMENT, [options.userId]);
  const review = await deps.pool.query<ReviewQueueCount>(REVIEW_QUEUE_STATEMENT);
  return { approvals, tasks: tasks.rows.map(taskRowOf), reviewQueue: review.rows };
}

export async function workspaceBoard(
  deps: WorkspaceViewDeps,
  recordType: string,
  options: BoardOptions = {},
): Promise<BoardView> {
  assertNotInWorkflow(WORKSPACE_BOARD_OPERATION);
  const record = deps.records.require(recordType);
  const limit = options.limit ?? DEFAULT_BOARD_LIMIT;
  // One row past the limit, trimmed before anything is columned: a count(*) would be a second
  // read of the same table under no lock, and could disagree with the page it is reported beside.
  const { rows: fetched } = await deps.pool.query<{
    id: string;
    title: unknown;
    stage: string | null;
    score: number | null;
    updated_at: Date | null;
  }>(
    `SELECT id::text AS id, ${quoteIdent(displayColumnOf(record))} AS title, stage, score, ` +
      `updated_at FROM ${quoteIdent(record.table)} WHERE archived_at IS NULL ` +
      "ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT $1",
    [limit + 1],
  );
  const truncated = fetched.length > limit;
  const rows = truncated ? fetched.slice(0, limit) : fetched;

  const columns = (record.stages ?? []).map((stage) => ({ stage, cards: [] as BoardCard[] }));
  const byStage = new Map(columns.map((column) => [column.stage.name, column]));
  const other: BoardCard[] = [];
  for (const row of rows) {
    const card: BoardCard = {
      id: row.id,
      title: textOf(row.title),
      stage: row.stage,
      score: row.score,
      updatedAt: row.updated_at,
    };
    const column = row.stage === null ? undefined : byStage.get(row.stage);
    if (column === undefined) other.push(card);
    else column.cards.push(card);
  }
  return { record, columns, other, limit, truncated };
}

export async function workspaceRecord(
  deps: WorkspaceViewDeps,
  recordType: string,
  id: string | number,
): Promise<RecordView | undefined> {
  assertNotInWorkflow(WORKSPACE_RECORD_OPERATION);
  const record = deps.records.require(recordType);
  const recordId = String(id);

  const { rows } = await deps.pool.query<Record<string, unknown>>(
    `SELECT * FROM ${quoteIdent(record.table)} WHERE id::text = $1`,
    [recordId],
  );
  const row = rows[0];
  if (row === undefined) return undefined;

  const [activity, labels, outcomes, tasks, approvals] = await Promise.all([
    listActivity(deps.pool, { recordType, recordId }),
    listLabels(deps.pool, { recordType, recordId }),
    listOutcomes(deps.pool, { recordType, recordId }),
    listTasksForRecord(deps.pool, recordType, recordId),
    pendingApprovals(deps, { admin: true, userId: null, recordType, recordId }),
  ]);

  return {
    record,
    id: recordId,
    title: textOf(row[displayColumnOf(record)]),
    row,
    archivedAt: (row.archived_at as Date | null | undefined) ?? null,
    timeline: await timelineOf(deps.pool, activity),
    labels,
    outcomes,
    tasks,
    pendingApprovals: approvals,
  };
}

async function listTasksForRecord(
  pool: Pool,
  recordType: string,
  recordId: string,
): Promise<TaskRow[]> {
  const { rows } = await pool.query<TaskQueryRow>(
    `SELECT ${TASK_COLUMNS} FROM hf_task WHERE record_type = $1 AND record_id = $2 ORDER BY id`,
    [recordType, recordId],
  );
  return rows.map(taskRowOf);
}

/**
 * Grouped in the order the entries arrive, which is `at, id`: a run's first write is where its
 * group sits, and the manual writes — `run_id` null — form one group of their own wherever
 * their first entry falls.
 */
async function timelineOf(pool: Pool, entries: ActivityRow[]): Promise<TimelineGroup[]> {
  const runIds = [...new Set(entries.map((entry) => entry.runId).filter((id) => id !== null))];
  const runs = new Map<string, { flow: string; started_at: Date }>();
  if (runIds.length > 0) {
    const { rows } = await pool.query<{ run_id: string; flow: string; started_at: Date }>(
      RUNS_STATEMENT,
      [runIds],
    );
    for (const run of rows) runs.set(run.run_id, run);
  }

  const groups = new Map<string | null, TimelineGroup>();
  const ordered: TimelineGroup[] = [];
  for (const entry of entries) {
    let group = groups.get(entry.runId);
    if (group === undefined) {
      const run = entry.runId === null ? undefined : runs.get(entry.runId);
      group = {
        runId: entry.runId,
        flow: run?.flow ?? null,
        startedAt: run?.started_at ?? null,
        entries: [],
      };
      groups.set(entry.runId, group);
      ordered.push(group);
    }
    group.entries.push(entry);
  }
  return ordered;
}

interface PendingScope {
  /** True for every pending row; false for the caller's own and the unassigned ones. */
  admin: boolean;
  userId: string | null;
  recordType?: string;
  recordId?: string;
}

async function pendingApprovals(
  deps: WorkspaceViewDeps,
  scope: PendingScope,
): Promise<InboxItem[]> {
  const { rows } = await deps.pool.query<InboxQueryRow>(INBOX_STATEMENT, [
    scope.admin,
    scope.userId,
    scope.recordType ?? null,
    scope.recordId ?? null,
  ]);
  const titles = await recordTitles(deps, rows);
  return rows.map((row) => ({
    approvalId: Number(row.id),
    runId: row.run_id,
    flow: row.flow,
    key: row.key,
    type: row.type,
    recordType: row.record_type,
    recordId: row.record_id,
    recordTitle:
      row.record_type === null || row.record_id === null
        ? null
        : (titles.get(`${row.record_type} ${row.record_id}`) ?? null),
    assigneeId: row.assignee_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    draft: row.draft,
    fields: draftFields(row.draft),
    editable: deps.hasSchema(row.type),
  }));
}

/**
 * One statement per record type the batch mentions, rather than one per row. An unregistered
 * type is skipped rather than refused: the inbox shows the approval, just without a name.
 */
async function recordTitles(
  deps: WorkspaceViewDeps,
  rows: readonly InboxQueryRow[],
): Promise<Map<string, string | null>> {
  const byType = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.record_type === null || row.record_id === null) continue;
    const ids = byType.get(row.record_type) ?? new Set<string>();
    ids.add(row.record_id);
    byType.set(row.record_type, ids);
  }

  const titles = new Map<string, string | null>();
  for (const [recordType, ids] of byType) {
    const record = deps.records.get(recordType);
    if (record === undefined) continue;
    const { rows: found } = await deps.pool.query<{ id: string; title: unknown }>(
      `SELECT id::text AS id, ${quoteIdent(displayColumnOf(record))} AS title ` +
        `FROM ${quoteIdent(record.table)} WHERE id::text = ANY($1::text[])`,
      [[...ids]],
    );
    for (const row of found) titles.set(`${recordType} ${row.id}`, textOf(row.title));
  }
  return titles;
}

function textOf(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
