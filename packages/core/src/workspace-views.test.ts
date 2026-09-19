import { DBOS, type DBOSClient } from "@dbos-inc/dbos-sdk";
import { ControlPlaneInWorkflow } from "@hyperfixation/db";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import {
  ApprovalBatchRefused,
  defineFlow,
  getClient,
  resetClient,
  type Flow,
} from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { AppNotAttached, defineApp, type App } from "./define-app.js";
import { UnknownRegistration } from "./registry.js";
import type { RecordDefinition } from "./records.js";
import { DEFAULT_BOARD_LIMIT } from "./workspace.js";

const RECORD_TYPE = "business";
const RECORD_TABLE = "businesses";

const BUSINESS: RecordDefinition = {
  table: RECORD_TABLE,
  recordType: RECORD_TYPE,
  title: "Businesses",
  displayColumn: "name",
  stages: [
    { name: "new", title: "New" },
    { name: "diligence", title: "Diligence" },
  ],
};

let database: TestDatabase;
let pool: Pool;
let client: DBOSClient;
let app: App;
let flow: Flow<{ n: number }, void>;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = new Pool({ max: 4, connectionString: database.applicationUrl });
  client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });

  await asRole(database.migratorUrl, async (pg) => {
    await pg.query(
      `CREATE TABLE ${RECORD_TABLE} (
         id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         name text NOT NULL,
         created_at timestamptz DEFAULT now(),
         updated_at timestamptz DEFAULT now(),
         archived_at timestamptz,
         stage text,
         score double precision,
         score_explanation text,
         spec_version integer,
         normalized_name text)`,
    );
    await pg.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${RECORD_TABLE} TO ${database.roles.application}`,
    );
    await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, '100')");
  });

  // Never dispatched: nothing launches DBOS here. It gives the bump path `decide()` runs a
  // queue name to enqueue the resumed attempt on.
  flow = defineFlow<{ n: number }, void>("inboxFlow", () => Promise.resolve(), { queue: "llm" });

  app = defineApp({
    name: database.appName,
    applicationVersion: "sha1234567",
    flows: [flow],
    records: [BUSINESS],
    approvalTypes: [
      { name: "send-letter", schema: z.object({ body: z.string() }) },
      // No schema, so nothing about it is editable from the inbox.
      { name: "call-them" },
    ],
  });
  app.attach({ pool, client });
}, 120_000);

afterAll(async () => {
  await resetClient();
  await pool?.end();
  await database?.drop();
});

// Every view reads whatever the whole table holds, so each test starts from an empty one.
beforeEach(async () => {
  await pool.query("DELETE FROM hf_approval");
  await pool.query("DELETE FROM hf_activity");
  await pool.query("DELETE FROM hf_task");
  await pool.query("DELETE FROM hf_label");
  await pool.query("DELETE FROM hf_outcome");
  await pool.query("DELETE FROM hf_source_record");
  await pool.query(`DELETE FROM ${RECORD_TABLE}`);
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface RecordFields {
  stage?: string | null;
  score?: number | null;
  archived?: boolean;
}

async function insertRecord(name: string, fields: RecordFields = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ${RECORD_TABLE} (name, stage, score, archived_at) ` +
      "VALUES ($1, $2, $3, CASE WHEN $4 THEN now() END) RETURNING id",
    [name, fields.stage ?? null, fields.score ?? null, fields.archived === true],
  );
  return rows[0]!.id;
}

async function insertRun(runId: string, flowName = "inboxFlow"): Promise<string> {
  await pool.query(
    "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
      "VALUES ($1, $2, '{}', 'waiting', 1, $1) ON CONFLICT (run_id) DO NOTHING",
    [runId, flowName],
  );
  return runId;
}

interface ApprovalFields {
  runId: string;
  key?: string;
  type?: string;
  recordId?: string | null;
  assigneeId?: string | null;
  draft?: unknown;
  status?: string;
}

async function insertApproval(fields: ApprovalFields): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO hf_approval (run_id, key, workflow_id, type, record_type, record_id, draft, " +
      "status, assignee_id) VALUES ($1, $2, $1, $3, $4, $5, $6::jsonb, $7, $8) RETURNING id",
    [
      fields.runId,
      fields.key ?? "send",
      fields.type ?? "send-letter",
      fields.recordId === undefined || fields.recordId === null ? null : RECORD_TYPE,
      fields.recordId ?? null,
      JSON.stringify(fields.draft ?? { body: "hello" }),
      fields.status ?? "pending",
      fields.assigneeId ?? null,
    ],
  );
  return Number(rows[0]!.id);
}

describe("workspace.inbox", () => {
  it("counts nothing as mine when the caller has no identity", async () => {
    await insertRun("anon-run");
    await insertApproval({ runId: "anon-run", key: "a" });
    await insertApproval({ runId: "anon-run", key: "b", assigneeId: "dana" });

    const anonymous = await app.workspace.inbox({ userId: null as unknown as string });
    expect(anonymous.items).toHaveLength(1);
    expect(anonymous).toMatchObject({ mine: 0, unassigned: 1 });
  });

  it("shows a user their own and the unassigned approvals, and an admin every one", async () => {
    const recordId = await insertRecord("acme");
    await insertRun("inbox-run");
    const mine = await insertApproval({ runId: "inbox-run", key: "a", assigneeId: "graham", recordId });
    const unassigned = await insertApproval({ runId: "inbox-run", key: "b", recordId });
    const theirs = await insertApproval({ runId: "inbox-run", key: "c", assigneeId: "dana" });
    // Decided, so no view of the inbox shows it.
    await insertApproval({ runId: "inbox-run", key: "d", status: "approved" });

    const graham = await app.workspace.inbox({ userId: "graham" });
    expect(graham.items.map((item) => item.approvalId)).toEqual([mine, unassigned]);
    expect(graham).toMatchObject({ mine: 1, unassigned: 1 });

    const dana = await app.workspace.inbox({ userId: "dana" });
    expect(dana.items.map((item) => item.approvalId)).toEqual([unassigned, theirs]);
    expect(dana).toMatchObject({ mine: 1, unassigned: 1 });

    const admin = await app.workspace.inbox({ userId: "graham", admin: true });
    expect(admin.items.map((item) => item.approvalId)).toEqual([mine, unassigned, theirs]);
    // The counts stay the admin's own: seeing everything is not owning everything.
    expect(admin).toMatchObject({ mine: 1, unassigned: 1 });

    expect(graham.items[0]).toMatchObject({
      runId: "inbox-run",
      flow: "inboxFlow",
      key: "a",
      type: "send-letter",
      recordType: RECORD_TYPE,
      recordId,
      recordTitle: "acme",
      assigneeId: "graham",
      editable: true,
    });
    // The approval names no record, so there is no title to find.
    expect(admin.items[2]).toMatchObject({ recordType: null, recordId: null, recordTitle: null });
  });

  it("marks an approval type with no registered schema uneditable", async () => {
    await insertRun("inbox-plain");
    await insertApproval({ runId: "inbox-plain", type: "call-them", draft: "ring them back" });

    const { items } = await app.workspace.inbox({ userId: "graham" });
    expect(items[0]).toMatchObject({ type: "call-them", editable: false });
    expect(items[0]!.fields).toEqual([
      { path: "value", segments: [], label: "Value", value: "ring them back" },
    ]);
  });

  it("hands a draft's markup on as the literal string it is", async () => {
    await insertRun("inbox-escape");
    await insertApproval({
      runId: "inbox-escape",
      draft: { body: '<img src=x onerror="alert(1)">' },
    });

    const { items } = await app.workspace.inbox({ userId: "graham" });
    expect(items[0]!.fields).toEqual([
      { path: "body", segments: ["body"], label: "Body", value: '<img src=x onerror="alert(1)">' },
    ]);
    expect(items[0]!.draft).toEqual({ body: '<img src=x onerror="alert(1)">' });
  });
});

describe("workspace.home", () => {
  it("combines the user's approvals, the open tasks they could pick up and the review queue", async () => {
    const recordId = await insertRecord("homely");
    await insertRun("home-run");
    const mine = await insertApproval({ runId: "home-run", key: "a", assigneeId: "graham", recordId });
    const unassigned = await insertApproval({ runId: "home-run", key: "b" });
    await insertApproval({ runId: "home-run", key: "c", assigneeId: "dana" });

    const openMine = await app.tasks.createManual({ title: "mine", ownerId: "graham" });
    const openAnyone = await app.tasks.createManual({ title: "anyone" });
    await app.tasks.createManual({ title: "dana's", ownerId: "dana" });
    const done = await app.tasks.createManual({ title: "done", ownerId: "graham" });
    await app.tasks.complete({ id: done.id });

    for (const [source, externalId, status] of [
      ["ga-filings", "1", "review"],
      ["ga-filings", "2", "review"],
      ["sos", "3", "review"],
      ["sos", "4", "new"],
    ]) {
      await pool.query(
        "INSERT INTO hf_source_record (source, external_id, payload, payload_hash, status) " +
          "VALUES ($1, $2, '{}'::jsonb, 'h', $3)",
        [source, externalId, status],
      );
    }

    const home = await app.workspace.home({ userId: "graham" });
    expect(home.approvals.map((item) => item.approvalId)).toEqual([mine, unassigned]);
    expect(home.tasks.map((task) => task.id)).toEqual([openMine.id, openAnyone.id]);
    expect(home.reviewQueue).toEqual([
      { source: "ga-filings", count: 2 },
      { source: "sos", count: 1 },
    ]);
  });
});

describe("workspace.board", () => {
  it("columns the registered stages and puts everything else in other", async () => {
    const newest = await insertRecord("in new", { stage: "new", score: 0.5 });
    const diligence = await insertRecord("in diligence", { stage: "diligence" });
    const unlisted = await insertRecord("in dead", { stage: "dead" });
    const stageless = await insertRecord("no stage");
    await insertRecord("gone", { stage: "new", archived: true });

    const board = await app.workspace.board(RECORD_TYPE);
    expect(board.record).toBe(BUSINESS);
    expect(board.columns.map((column) => column.stage.name)).toEqual(["new", "diligence"]);
    expect(board.columns[0]!.cards.map((card) => card.id)).toEqual([newest]);
    expect(board.columns[1]!.cards.map((card) => card.id)).toEqual([diligence]);
    // A stage the app does not list and no stage at all land in the same place.
    expect(board.other.map((card) => card.id).sort()).toEqual([unlisted, stageless].sort());
    expect(board.columns[0]!.cards[0]).toMatchObject({
      title: "in new",
      stage: "new",
      score: 0.5,
    });
    expect(board.columns[0]!.cards[0]!.updatedAt).toBeInstanceOf(Date);
  });

  it("stops at the limit it is given and says it did", async () => {
    for (const name of ["one", "two", "three"]) await insertRecord(name, { stage: "new" });

    const board = await app.workspace.board(RECORD_TYPE, { limit: 2 });
    expect(board.columns[0]!.cards).toHaveLength(2);
    expect(board).toMatchObject({ limit: 2, truncated: true });
  });

  it("is not truncated when the rows come to exactly the limit", async () => {
    for (const name of ["one", "two"]) await insertRecord(name, { stage: "new" });

    const board = await app.workspace.board(RECORD_TYPE, { limit: 2 });
    expect(board.columns[0]!.cards).toHaveLength(2);
    expect(board).toMatchObject({ limit: 2, truncated: false });
  });

  it("reports the default limit when the caller gives none", async () => {
    await insertRecord("only", { stage: "new" });

    const board = await app.workspace.board(RECORD_TYPE);
    expect(board).toMatchObject({ limit: DEFAULT_BOARD_LIMIT, truncated: false });
  });

  it("refuses a record type this app never registered", async () => {
    await expect(app.workspace.board("ghost")).rejects.toBeInstanceOf(UnknownRegistration);
  });
});

describe("workspace.record", () => {
  it("groups the timeline by run and gives the manual writes their own group", async () => {
    const recordId = await insertRecord("timeline", { stage: "new" });
    await insertRun("run-a", "firstFlow");
    await insertRun("run-b", "secondFlow");

    for (const [runId, key, kind] of [
      ["run-a", "k1", "run.started"],
      ["run-a", "k2", "score.written"],
      ["run-b", "k3", "action.performed"],
    ]) {
      await pool.query(
        "INSERT INTO hf_activity (record_type, record_id, kind, run_id, key) " +
          "VALUES ($1, $2, $3, $4, $5)",
        [RECORD_TYPE, recordId, kind, runId, key],
      );
    }
    await app.labels.add({
      recordType: RECORD_TYPE,
      recordId,
      target: "record",
      value: "up",
      userId: "graham",
    });

    const view = await app.workspace.record(RECORD_TYPE, recordId);
    expect(view).toBeDefined();
    expect(view!.timeline).toHaveLength(3);
    expect(view!.timeline.map((group) => [group.runId, group.flow])).toEqual([
      ["run-a", "firstFlow"],
      ["run-b", "secondFlow"],
      // The label's activity row carries no run, and nothing invents one for it.
      [null, null],
    ]);
    expect(view!.timeline[0]!.entries.map((entry) => entry.kind)).toEqual([
      "run.started",
      "score.written",
    ]);
    expect(view!.timeline[0]!.startedAt).toBeInstanceOf(Date);
    expect(view!.timeline[2]!.startedAt).toBeNull();
    expect(view!.timeline[2]!.entries.map((entry) => entry.kind)).toEqual(["label.added"]);
  });

  it("keeps a run whose id is the empty string apart from the manual writes", async () => {
    const recordId = await insertRecord("empty-run", { stage: "new" });
    await insertRun("", "oddFlow");
    await pool.query(
      "INSERT INTO hf_activity (record_type, record_id, kind, run_id, key) VALUES ($1, $2, 'run.started', '', 'k1')",
      [RECORD_TYPE, recordId],
    );
    await app.labels.add({ recordType: RECORD_TYPE, recordId, target: "record", value: "up", userId: "graham" });

    const view = await app.workspace.record(RECORD_TYPE, recordId);
    expect(view!.timeline.map((group) => [group.runId, group.flow])).toEqual([
      ["", "oddFlow"],
      [null, null],
    ]);
  });

  it("carries the record's own row, its labels, outcomes, tasks and pending approvals", async () => {
    const recordId = await insertRecord("full", { stage: "diligence", score: 0.25 });
    await insertRun("record-run");
    const assignedElsewhere = await insertApproval({
      runId: "record-run",
      recordId,
      assigneeId: "dana",
    });
    // On another record, so the record page never shows it.
    await insertApproval({ runId: "record-run", key: "other" });
    await app.labels.add({ recordType: RECORD_TYPE, recordId, target: "record", value: "down" });
    await app.outcomes.record({ recordType: RECORD_TYPE, recordId, outcome: "won" });
    const task = await app.tasks.createManual({
      title: "follow up",
      recordType: RECORD_TYPE,
      recordId,
    });

    const view = (await app.workspace.record(RECORD_TYPE, recordId))!;
    expect(view).toMatchObject({ id: recordId, title: "full", archivedAt: null });
    expect(view.row).toMatchObject({ name: "full", stage: "diligence", score: 0.25 });
    expect(view.labels.map((label) => label.value)).toEqual(["down"]);
    expect(view.outcomes.map((outcome) => outcome.outcome)).toEqual(["won"]);
    expect(view.tasks.map((row) => row.id)).toEqual([task.id]);
    // The record page shows every pending approval on the record, assignee or not; who may
    // decide one is `decide()`'s question, not this read's.
    expect(view.pendingApprovals.map((item) => item.approvalId)).toEqual([assignedElsewhere]);
  });

  it("resolves an archived record and answers undefined for an id nothing holds", async () => {
    const recordId = await insertRecord("gone", { archived: true });

    const view = (await app.workspace.record(RECORD_TYPE, recordId))!;
    expect(view.archivedAt).toBeInstanceOf(Date);
    expect(await app.workspace.record(RECORD_TYPE, "9999999")).toBeUndefined();
  });
});

describe("workspace.decide", () => {
  async function startedApproval(
    runId: string,
    assigneeId: string | null = null,
  ): Promise<number> {
    await app.runs.start(flow, { n: 1 }, { runId });
    await pool.query("UPDATE hf_run SET status = 'waiting' WHERE run_id = $1", [runId]);
    return insertApproval({ runId, assigneeId });
  }

  async function approvalRows(ids: number[]): Promise<Record<string, unknown>[]> {
    const { rows } = await pool.query(
      "SELECT id, status, edited_draft, decision_key, decided_by, decided_via, batch_id " +
        "FROM hf_approval WHERE id = ANY($1::bigint[]) ORDER BY id",
      [ids],
    );
    return rows;
  }

  it("decides a batch with one edit as the web, once per decision key", async () => {
    const first = await startedApproval(`decide-a-${Date.now()}`);
    const second = await startedApproval(`decide-b-${Date.now()}`);
    const decisionKey = "client-key-1";

    const result = await app.workspace.decide({
      ids: [first, second],
      decision: "approved",
      edits: { [first]: { body: "edited by hand" } },
      decisionKey,
      userId: "graham",
      admin: false,
    });
    expect(result.replayed).toBe(false);
    expect(result.decided.map((decided) => decided.approvalId).sort()).toEqual(
      [first, second].sort(),
    );

    const rows = await approvalRows([first, second]);
    expect(rows[0]).toMatchObject({
      status: "approved",
      edited_draft: { body: "edited by hand" },
      decision_key: decisionKey,
      decided_by: "graham",
      decided_via: "web",
    });
    expect(rows[1]).toMatchObject({ status: "approved", edited_draft: null, decision_key: decisionKey });
    expect(rows[0]!.batch_id).toEqual(rows[1]!.batch_id);

    // The double submit the client's one-per-mount key exists for.
    const again = await app.workspace.decide({
      ids: [first, second],
      decision: "approved",
      decisionKey,
      userId: "graham",
      admin: false,
    });
    expect(again.replayed).toBe(true);
    expect(again.decided.map((decided) => decided.approvalId).sort()).toEqual(
      [first, second].sort(),
    );
  });

  it("refuses a row assigned to someone else unless the session is an admin", async () => {
    const assigned = await startedApproval(`decide-assigned-${Date.now()}`, "dana");

    await expect(
      app.workspace.decide({
        ids: [assigned],
        decision: "approved",
        decisionKey: "client-key-2",
        userId: "graham",
        admin: false,
      }),
    ).rejects.toBeInstanceOf(ApprovalBatchRefused);
    expect((await approvalRows([assigned]))[0]).toMatchObject({ status: "pending" });

    const result = await app.workspace.decide({
      ids: [assigned],
      decision: "approved",
      decisionKey: "client-key-3",
      userId: "graham",
      admin: true,
    });
    expect(result.decided.map((decided) => decided.approvalId)).toEqual([assigned]);
  });
});

describe("the control-plane fence", () => {
  const unattached = defineApp({ name: "unattached", records: [BUSINESS] });

  it("refuses every view before attach", async () => {
    await expect(unattached.workspace.inbox({ userId: "graham" })).rejects.toBeInstanceOf(
      AppNotAttached,
    );
    await expect(unattached.workspace.home({ userId: "graham" })).rejects.toBeInstanceOf(
      AppNotAttached,
    );
    await expect(unattached.workspace.board(RECORD_TYPE)).rejects.toBeInstanceOf(AppNotAttached);
    await expect(unattached.workspace.record(RECORD_TYPE, "1")).rejects.toBeInstanceOf(
      AppNotAttached,
    );
    await expect(
      unattached.workspace.decide({
        ids: [1],
        decision: "approved",
        decisionKey: "k",
        userId: "graham",
      }),
    ).rejects.toBeInstanceOf(AppNotAttached);
    // The descriptors need no handles and keep working.
    expect(unattached.workspace.route("/w")).toEqual({ kind: "home" });
  });

  it("refuses every view from inside a run, before it issues a statement", async () => {
    vi.spyOn(DBOS, "isWithinWorkflow").mockReturnValue(true);
    const query = vi.spyOn(pool, "query");

    await expect(app.workspace.inbox({ userId: "graham" })).rejects.toBeInstanceOf(
      ControlPlaneInWorkflow,
    );
    await expect(app.workspace.home({ userId: "graham" })).rejects.toBeInstanceOf(
      ControlPlaneInWorkflow,
    );
    await expect(app.workspace.board(RECORD_TYPE)).rejects.toBeInstanceOf(ControlPlaneInWorkflow);
    await expect(app.workspace.record(RECORD_TYPE, "1")).rejects.toBeInstanceOf(
      ControlPlaneInWorkflow,
    );
    await expect(
      app.workspace.decide({
        ids: [1],
        decision: "approved",
        decisionKey: "k",
        userId: "graham",
      }),
    ).rejects.toBeInstanceOf(ControlPlaneInWorkflow);

    expect(query).not.toHaveBeenCalled();
  });
});
