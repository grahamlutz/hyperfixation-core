import { DBOS, type DBOSClient } from "@dbos-inc/dbos-sdk";
import { ControlPlaneInWorkflow } from "@hyperfixation/db";
import { asRole, createTestDatabase, testBuildSha, type TestDatabase } from "@hyperfixation/testing";
import { defineFlow, getClient, resetClient, type Flow } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defineApp, type App } from "./define-app.js";
import { UnknownRegistration } from "./registry.js";

const RECORD_TYPE = "business";
const RECORD_TABLE = "businesses";

let database: TestDatabase;
let pool: Pool;
let client: DBOSClient;
let app: App;
let flow: Flow<{ n: number }, void>;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = new Pool({ max: 4, connectionString: database.applicationUrl });
  client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });

  // The app record table a Phase 2 `defineRecord` would generate: a bigint identity `id` and
  // the mixin's `archived_at`, which is the column `archive()` writes.
  await asRole(database.migratorUrl, async (pg) => {
    await pg.query(
      `CREATE TABLE ${RECORD_TABLE} (
         id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         name text NOT NULL,
         archived_at timestamptz)`,
    );
    await pg.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${RECORD_TABLE} TO ${database.roles.application}`);
    await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, '100')");
  });

  // Never dispatched: nothing launches DBOS here. It exists so the bump path `decide()` runs
  // has a queue name to enqueue the resumed attempt on.
  flow = defineFlow<{ n: number }, void>("archiveFlow", () => Promise.resolve(), { queue: "llm" });

  app = defineApp({
    name: database.appName,
    applicationVersion: "sha1234567",
    flows: [flow],
    records: [{ table: RECORD_TABLE, recordType: RECORD_TYPE }],
  });
  app.attach({ pool, client });
}, 120_000);

afterAll(async () => {
  await resetClient();
  await pool?.end();
  await database?.drop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function insertRecord(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ${RECORD_TABLE} (name) VALUES ($1) RETURNING id`,
    [name],
  );
  return rows[0]!.id;
}

async function archivedAt(recordId: string): Promise<Date | null> {
  const { rows } = await pool.query<{ archived_at: Date | null }>(
    `SELECT archived_at FROM ${RECORD_TABLE} WHERE id = $1`,
    [recordId],
  );
  return rows[0]!.archived_at;
}

/**
 * `fence.test.ts` case (vii)'s other half. Chunk 5 could only drive a stand-in — the function
 * did not exist yet to guard — so this is the same assertion against the real one.
 */
describe("fence.test.ts case (vii) — records.archive() from inside a run", () => {
  it("throws ControlPlaneInWorkflow before it issues a statement", async () => {
    const recordId = await insertRecord("acme");
    vi.spyOn(DBOS, "isWithinWorkflow").mockReturnValue(true);
    const connect = vi.spyOn(pool, "connect");
    const query = vi.spyOn(pool, "query");

    await expect(
      app.records.archive({ recordType: RECORD_TYPE, recordId }),
    ).rejects.toBeInstanceOf(ControlPlaneInWorkflow);

    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(await archivedAt(recordId)).toBeNull();
  });
});

describe("records.archive()", () => {
  it("refuses a record type this app never registered", async () => {
    await expect(app.records.archive({ recordType: "ghost", recordId: "1" })).rejects.toBeInstanceOf(
      UnknownRegistration,
    );
  });

  it("archives the record once and audits it", async () => {
    const recordId = await insertRecord("stamps");

    const first = await app.records.archive({
      recordType: RECORD_TYPE,
      recordId,
      userId: "graham",
      reason: "duplicate",
    });
    expect(first).toMatchObject({ archived: true, cancelledApprovals: [] });
    const at = await archivedAt(recordId);
    expect(at).toBeInstanceOf(Date);

    // Archiving twice is not an error and does not re-stamp: the row is already gone as far as
    // the app is concerned, and a moved `archived_at` would rewrite when it went.
    const second = await app.records.archive({ recordType: RECORD_TYPE, recordId });
    expect(second.archived).toBe(false);
    expect(await archivedAt(recordId)).toEqual(at);

    const { rows } = await pool.query<{ actor_id: string | null; meta: Record<string, unknown> }>(
      "SELECT actor_id, meta FROM hf_audit WHERE action = 'record.archived' AND target_id = $1 " +
        "ORDER BY id",
      [recordId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor_id: "graham" });
    expect(rows[0]!.meta).toMatchObject({ reason: "duplicate", alreadyArchived: false });
    expect(rows[1]!.meta).toMatchObject({ alreadyArchived: true });
  });

  it("cancels the record's pending approvals through decide(), so their runs move on", async () => {
    const recordId = await insertRecord("under-review");
    const runId = `archive-${testBuildSha()}`;
    await app.runs.start(flow, { n: 1 }, { runId });
    await pool.query("UPDATE hf_run SET status = 'waiting' WHERE run_id = $1", [runId]);

    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO hf_approval (run_id, key, workflow_id, type, record_type, record_id, draft, " +
        "status) VALUES ($1, 'send', $1, 'send-letter', $2, $3, '{}'::jsonb, 'pending') RETURNING id",
      [runId, RECORD_TYPE, recordId],
    );
    const approvalId = Number(rows[0]!.id);

    const result = await app.records.archive({
      recordType: RECORD_TYPE,
      recordId,
      userId: "graham",
    });

    expect(result).toMatchObject({ archived: true, cancelledApprovals: [approvalId] });

    const approval = await pool.query<{ status: string; decided_via: string; resume_workflow_id: string }>(
      "SELECT status, decided_via, resume_workflow_id FROM hf_approval WHERE id = $1",
      [approvalId],
    );
    expect(approval.rows[0]).toMatchObject({
      status: "cancelled",
      decided_via: "archive",
      resume_workflow_id: `${runId}:2`,
    });

    // The decision bumped the run in its own transaction and enqueued the attempt that will
    // see the cancellation, exactly as a human's decision does.
    const run = await pool.query<{ status: string; attempt: number; current_workflow_id: string }>(
      "SELECT status, attempt, current_workflow_id FROM hf_run WHERE run_id = $1",
      [runId],
    );
    expect(run.rows[0]).toMatchObject({
      status: "running",
      attempt: 2,
      current_workflow_id: `${runId}:2`,
    });

    const enqueued = await pool.query<{ status: string }>(
      "SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1",
      [`${runId}:2`],
    );
    expect(enqueued.rows[0]).toMatchObject({ status: "ENQUEUED" });
  });
});
