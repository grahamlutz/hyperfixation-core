import { checkE002, type RecordTable } from "@hyperfixation/db";
import { createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listOutcomes, recordOutcome } from "./outcomes.js";
import { createRegistry, UnknownRegistration, type Registry } from "./registry.js";

const RECORD_TYPE = "business";
const REGISTERED: RecordTable[] = [{ table: "businesses", recordType: RECORD_TYPE }];

let database: TestDatabase;
let pool: Pool;
let records: Registry<RecordTable>;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = new Pool({ max: 4, connectionString: database.applicationUrl });
  records = createRegistry<RecordTable>("record type", (entry) => entry.recordType);
  for (const record of REGISTERED) records.register(record);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

async function activityRows(outcomeId: number): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(
    "SELECT kind, record_type, record_id, actor_id, body, run_id, key FROM hf_activity " +
      "WHERE meta->>'outcomeId' = $1 ORDER BY id",
    [String(outcomeId)],
  );
  return rows;
}

describe("outcomes.record", () => {
  it("stamps now() and writes one activity row with no run", async () => {
    const before = new Date();
    const outcome = await recordOutcome(pool, records, {
      recordType: RECORD_TYPE,
      recordId: 21,
      outcome: "won",
      notes: "signed the lease",
      userId: "graham",
    });

    const { rows } = await pool.query<{ outcome: string; at: Date; notes: string | null }>(
      "SELECT outcome, at, notes FROM hf_outcome WHERE id = $1",
      [outcome.id],
    );
    expect(rows[0]).toMatchObject({ outcome: "won", notes: "signed the lease" });
    expect(rows[0]!.at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);

    const activity = await activityRows(outcome.id);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      kind: "outcome.recorded",
      record_type: RECORD_TYPE,
      record_id: "21",
      actor_id: "graham",
      body: "signed the lease",
      run_id: null,
      key: null,
    });
    await expect(checkE002(pool, REGISTERED)).resolves.toBeUndefined();
  });

  it("keeps an `at` the caller supplies — an outcome is often learned after the fact", async () => {
    const at = new Date("2026-08-01T12:00:00Z");
    const outcome = await recordOutcome(pool, records, {
      recordType: RECORD_TYPE,
      recordId: 22,
      outcome: "lost",
      at,
    });

    const { rows } = await pool.query<{ at: Date }>("SELECT at FROM hf_outcome WHERE id = $1", [
      outcome.id,
    ]);
    expect(rows[0]!.at).toEqual(at);
  });

  it("refuses a record type this app never registered, before any statement", async () => {
    await expect(
      recordOutcome(pool, records, { recordType: "ghost", recordId: 1, outcome: "won" }),
    ).rejects.toBeInstanceOf(UnknownRegistration);

    const { rows } = await pool.query("SELECT 1 FROM hf_outcome WHERE record_type = 'ghost'");
    expect(rows).toHaveLength(0);
  });
});

describe("outcomes.list", () => {
  it("returns a record's outcomes oldest first", async () => {
    const later = await recordOutcome(pool, records, {
      recordType: RECORD_TYPE,
      recordId: 23,
      outcome: "closed",
      at: new Date("2026-09-01T00:00:00Z"),
    });
    const earlier = await recordOutcome(pool, records, {
      recordType: RECORD_TYPE,
      recordId: 23,
      outcome: "contacted",
      at: new Date("2026-07-01T00:00:00Z"),
    });

    const rows = await listOutcomes(pool, { recordType: RECORD_TYPE, recordId: 23 });
    expect(rows.map((row) => [row.id, row.outcome])).toEqual([
      [earlier.id, "contacted"],
      [later.id, "closed"],
    ]);
  });
});
