import { checkE002, createStepPool, type RecordTable, type StepPool } from "@hyperfixation/db";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import type { StepContext } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistry, UnknownRegistration, type Registry } from "./registry.js";
import {
  cancelTask,
  completeTask,
  createManualTask,
  createTask,
  flowOriginRef,
  listTasks,
} from "./tasks.js";

const RECORD_TYPE = "business";
const REGISTERED: RecordTable[] = [{ table: "businesses", recordType: RECORD_TYPE }];

let database: TestDatabase;
let pool: Pool;
let steps: StepPool;
let records: Registry<RecordTable>;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = new Pool({ max: 4, connectionString: database.applicationUrl });
  steps = createStepPool({ connectionString: database.applicationUrl });
  records = createRegistry<RecordTable>("record type", (entry) => entry.recordType);
  for (const record of REGISTERED) records.register(record);
}, 120_000);

afterAll(async () => {
  await steps?.end();
  await pool?.end();
  await database?.drop();
});

async function context(runId: string, key: string, attempt = 1): Promise<StepContext> {
  const workflowId = attempt === 1 ? runId : `${runId}:${attempt}`;
  await asRole(database.applicationUrl, async (pg) => {
    await pg.query(
      "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
        "VALUES ($1, 'test', '{}', 'running', $2, $3) " +
        "ON CONFLICT (run_id) DO UPDATE SET attempt = $2, current_workflow_id = $3",
      [runId, attempt, workflowId],
    );
  });
  return { runId, attempt, workflowId, key, tx: (work) => steps.tx(runId, workflowId, work) };
}

async function taskRows(originRef: string | null): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(
    "SELECT id, record_type, record_id, title, owner_id, due_at, origin, origin_ref, done_at, " +
      "cancelled_at FROM hf_task WHERE origin_ref IS NOT DISTINCT FROM $1 ORDER BY id",
    [originRef],
  );
  return rows;
}

async function activityRows(taskId: number): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(
    "SELECT kind, record_type, record_id, actor_id, run_id, key FROM hf_activity " +
      "WHERE meta->>'taskId' = $1 ORDER BY id",
    [String(taskId)],
  );
  return rows;
}

describe("tasks.create", () => {
  // First in the file: E002 is asked against an empty registry, which only passes while every
  // machinery row still carries NULL.
  it("writes NULL target columns for a task about no record", async () => {
    const created = await createTask(await context("task-no-record", "sweep"), records, {
      title: "look at the queue",
    });

    expect((await taskRows(flowOriginRef("task-no-record", "sweep")))[0]).toMatchObject({
      record_type: null,
      record_id: null,
      origin: "flow",
    });
    expect((await activityRows(created.id))[0]).toMatchObject({ record_type: null });
    await expect(checkE002(pool, [])).resolves.toBeUndefined();
  });

  it("opens one task per (run, key) however many attempts run the step", async () => {
    const first = await createTask(await context("task-replay", "follow-up"), records, {
      title: "call them back",
      recordType: RECORD_TYPE,
      recordId: 3,
      ownerId: "graham",
    });
    expect(first).toMatchObject({ created: true });

    const second = await createTask(await context("task-replay", "follow-up", 2), records, {
      title: "call them back",
      recordType: RECORD_TYPE,
      recordId: 3,
      ownerId: "graham",
    });
    expect(second).toEqual({ id: first.id, created: false });

    const rows = await taskRows(flowOriginRef("task-replay", "follow-up"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      record_type: RECORD_TYPE,
      record_id: "3",
      title: "call them back",
      owner_id: "graham",
      origin: "flow",
      // The colon is what keeps this disjoint from `actions.perform`'s bare `hf_action_log` id
      // on the same partial unique index.
      origin_ref: "task-replay:follow-up",
    });

    const activity = await activityRows(first.id);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      kind: "task.created",
      run_id: "task-replay",
      key: "follow-up:task.created",
    });
    await expect(checkE002(pool, REGISTERED)).resolves.toBeUndefined();
  });

  it("refuses a record type this app never registered", async () => {
    const ctx = await context("task-ghost", "x");
    await expect(
      createTask(ctx, records, { title: "t", recordType: "ghost", recordId: 1 }),
    ).rejects.toBeInstanceOf(UnknownRegistration);
    expect(await taskRows(flowOriginRef("task-ghost", "x"))).toHaveLength(0);
  });
});

describe("tasks.createManual", () => {
  it("writes origin 'manual', no origin_ref, and an activity row with no run", async () => {
    const created = await createManualTask(pool, records, {
      title: "chase the lease",
      recordType: RECORD_TYPE,
      recordId: 4,
      userId: "graham",
      dueAt: new Date("2026-10-01T00:00:00Z"),
    });
    expect(created).toEqual({ id: created.id, created: true });

    const rows = await pool.query<Record<string, unknown>>(
      "SELECT origin, origin_ref, due_at FROM hf_task WHERE id = $1",
      [created.id],
    );
    expect(rows.rows[0]).toMatchObject({ origin: "manual", origin_ref: null });
    expect(rows.rows[0]!.due_at).toEqual(new Date("2026-10-01T00:00:00Z"));

    expect((await activityRows(created.id))[0]).toMatchObject({
      kind: "task.created",
      actor_id: "graham",
      run_id: null,
      key: null,
    });
  });

  it("gives two calls with the same title two tasks — nothing keys a manual task", async () => {
    const one = await createManualTask(pool, records, { title: "same" });
    const two = await createManualTask(pool, records, { title: "same" });
    expect(two.id).toBeGreaterThan(one.id);
  });
});

describe("tasks.complete / tasks.cancel", () => {
  it("closes an open task once and writes one activity row", async () => {
    const task = await createManualTask(pool, records, {
      title: "close me",
      recordType: RECORD_TYPE,
      recordId: 5,
    });

    const closed = await completeTask(pool, { id: task.id, userId: "graham" });
    expect(closed).toEqual({ id: task.id, changed: true });

    // A second call changes nothing, and a timeline that showed it twice would be a lie.
    expect(await completeTask(pool, { id: task.id, userId: "graham" })).toEqual({
      id: task.id,
      changed: false,
    });
    expect(await cancelTask(pool, { id: task.id })).toEqual({ id: task.id, changed: false });

    const kinds = (await activityRows(task.id)).map((row) => row.kind);
    expect(kinds).toEqual(["task.created", "task.completed"]);
  });

  it("cancels an open task and refuses to complete it afterwards", async () => {
    const task = await createManualTask(pool, records, { title: "cancel me" });

    expect(await cancelTask(pool, { id: task.id, userId: "dana" })).toEqual({
      id: task.id,
      changed: true,
    });
    expect(await completeTask(pool, { id: task.id })).toEqual({ id: task.id, changed: false });
    expect((await activityRows(task.id)).map((row) => row.kind)).toEqual([
      "task.created",
      "task.cancelled",
    ]);
  });

  it("answers a task id nothing wrote with changed: false", async () => {
    expect(await completeTask(pool, { id: 9_999_999 })).toEqual({ id: 9_999_999, changed: false });
  });
});

describe("tasks.list", () => {
  it("filters by record, owner and openness", async () => {
    const open = await createManualTask(pool, records, {
      title: "open one",
      recordType: RECORD_TYPE,
      recordId: 6,
      ownerId: "lister",
    });
    const done = await createManualTask(pool, records, {
      title: "done one",
      recordType: RECORD_TYPE,
      recordId: 6,
      ownerId: "dana",
    });
    await completeTask(pool, { id: done.id });

    const onRecord = await listTasks(pool, { recordType: RECORD_TYPE, recordId: 6 });
    expect(onRecord.map((row) => row.id)).toEqual([open.id, done.id]);

    expect((await listTasks(pool, { recordType: RECORD_TYPE, recordId: 6, open: true })).map(
      (row) => row.id,
    )).toEqual([open.id]);
    expect((await listTasks(pool, { recordType: RECORD_TYPE, recordId: 6, open: false })).map(
      (row) => row.id,
    )).toEqual([done.id]);
    expect((await listTasks(pool, { ownerId: "lister", open: true })).map((row) => row.id)).toEqual(
      [open.id],
    );
    expect(onRecord[0]).toMatchObject({ title: "open one", origin: "manual", doneAt: null });
  });
});
