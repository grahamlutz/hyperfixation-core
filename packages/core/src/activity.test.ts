import { checkE002, createStepPool, type StepPool } from "@hyperfixation/db";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import type { StepContext } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertActivity, InvalidActivityKind, listActivity, recordActivity } from "./activity.js";

const RECORD_TYPE = "business";
const RECORD_TABLE = "businesses";
const REGISTERED = [{ table: RECORD_TABLE, recordType: RECORD_TYPE }];

let database: TestDatabase;
let pool: Pool;
let steps: StepPool;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = new Pool({ max: 4, connectionString: database.applicationUrl });
  steps = createStepPool({ connectionString: database.applicationUrl });
}, 120_000);

afterAll(async () => {
  await steps?.end();
  await pool?.end();
  await database?.drop();
});

/** A step context under a named attempt, with the `hf_run` row its `ctx.tx` fence reads. */
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

async function rowsOf(runId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(
    "SELECT id, record_type, record_id, kind, run_id, key, meta FROM hf_activity " +
      "WHERE run_id = $1 ORDER BY id",
    [runId],
  );
  return rows;
}

describe("activity.record", () => {
  it("writes NULL for a row about no record, which E002 ignores", async () => {
    await recordActivity(await context("activity-no-record", "gate"), { kind: "gate.opened" });

    const rows = await rowsOf("activity-no-record");
    expect(rows[0]).toMatchObject({ record_type: null, record_id: null });
    // The reason a pseudo record type is never written: E002 refuses the next boot over one.
    // Asked against this file's own registry rather than an empty one, which would only pass
    // while no other case here had written a `record_type` yet — declaration order, not a claim.
    await expect(checkE002(pool, REGISTERED)).resolves.toBeUndefined();
  });

  it("writes one row per (run, key) however many attempts run the step", async () => {
    const first = await recordActivity(await context("activity-replay", "note"), {
      kind: "note.added",
      recordType: RECORD_TYPE,
      recordId: 7,
      body: "looked promising",
    });
    expect(first).toMatchObject({ created: true });

    // Attempt 2 is a new workflow id running the same step: the key is what makes it once-only.
    const second = await recordActivity(await context("activity-replay", "note", 2), {
      kind: "note.added",
      recordType: RECORD_TYPE,
      recordId: 7,
      body: "looked promising",
    });
    expect(second).toEqual({ id: first.id, created: false });

    const rows = await rowsOf("activity-replay");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      record_type: RECORD_TYPE,
      record_id: "7",
      kind: "note.added",
      run_id: "activity-replay",
      key: "note:note.added",
    });
    await expect(checkE002(pool, REGISTERED)).resolves.toBeUndefined();
  });

  it("gives two kinds from one step two rows", async () => {
    const ctx = await context("activity-two-kinds", "sweep");
    await recordActivity(ctx, { kind: "sweep.started" });
    await recordActivity(ctx, { kind: "sweep.finished" });

    expect((await rowsOf("activity-two-kinds")).map((row) => row.kind)).toEqual([
      "sweep.started",
      "sweep.finished",
    ]);
  });

  it("refuses a kind that is not <noun>.<verb>", async () => {
    const ctx = await context("activity-bad-kind", "k");
    for (const kind of ["created", "Task.Created", "task.", "task..created", "task created"]) {
      await expect(recordActivity(ctx, { kind })).rejects.toBeInstanceOf(InvalidActivityKind);
    }
    expect(await rowsOf("activity-bad-kind")).toHaveLength(0);
  });
});

describe("activity.list", () => {
  it("orders by time and carries the run id, null for a web-side row", async () => {
    await recordActivity(await context("activity-list", "draft"), {
      kind: "draft.written",
      recordType: RECORD_TYPE,
      recordId: 11,
    });
    await insertActivity(pool, {
      kind: "label.added",
      recordType: RECORD_TYPE,
      recordId: 11,
      actorId: "graham",
    });

    const rows = await listActivity(pool, { recordType: RECORD_TYPE, recordId: 11 });
    expect(rows.map((row) => [row.kind, row.runId])).toEqual([
      ["draft.written", "activity-list"],
      ["label.added", null],
    ]);
    expect(rows[1]).toMatchObject({ actorId: "graham" });
    expect(rows[0]!.at).toBeInstanceOf(Date);
  });
});
