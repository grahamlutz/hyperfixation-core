import { checkE002, type RecordTable } from "@hyperfixation/db";
import { createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addLabel, listLabels } from "./labels.js";
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

async function activityRows(labelId: number): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query(
    "SELECT kind, record_type, record_id, actor_id, run_id, key, meta FROM hf_activity " +
      "WHERE meta->>'labelId' = $1 ORDER BY id",
    [String(labelId)],
  );
  return rows;
}

describe("labels.add", () => {
  it("writes the label and one activity row with no run", async () => {
    const label = await addLabel(pool, records, {
      recordType: RECORD_TYPE,
      recordId: 12,
      target: "score",
      targetId: 88,
      value: "down",
      correction: { score: 0.2 },
      userId: "graham",
    });

    const { rows } = await pool.query<Record<string, unknown>>(
      "SELECT record_type, record_id, target, target_id, value, correction, user_id FROM hf_label " +
        "WHERE id = $1",
      [label.id],
    );
    expect(rows[0]).toMatchObject({
      record_type: RECORD_TYPE,
      record_id: "12",
      target: "score",
      target_id: "88",
      value: "down",
      correction: { score: 0.2 },
      user_id: "graham",
    });

    const activity = await activityRows(label.id);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      kind: "label.added",
      record_type: RECORD_TYPE,
      record_id: "12",
      actor_id: "graham",
      // Web-side: null is what C6's timeline groups under "manual".
      run_id: null,
      key: null,
    });
    await expect(checkE002(pool, REGISTERED)).resolves.toBeUndefined();
  });

  it("refuses a record type this app never registered, before any statement", async () => {
    await expect(
      addLabel(pool, records, {
        recordType: "ghost",
        recordId: 1,
        target: "record",
        value: "up",
      }),
    ).rejects.toBeInstanceOf(UnknownRegistration);

    const { rows } = await pool.query("SELECT 1 FROM hf_label WHERE record_type = 'ghost'");
    expect(rows).toHaveLength(0);
  });
});

describe("labels.list", () => {
  it("returns a record's labels oldest first", async () => {
    const up = await addLabel(pool, records, {
      recordType: RECORD_TYPE,
      recordId: 13,
      target: "draft",
      value: "up",
    });
    const correction = await addLabel(pool, records, {
      recordType: RECORD_TYPE,
      recordId: 13,
      target: "draft",
      value: "correction",
      correction: { body: "shorter" },
    });

    const rows = await listLabels(pool, { recordType: RECORD_TYPE, recordId: 13 });
    expect(rows.map((row) => row.id)).toEqual([up.id, correction.id]);
    expect(rows[0]).toMatchObject({ target: "draft", value: "up", correction: null, userId: null });
    expect(rows[1]!.correction).toEqual({ body: "shorter" });
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });
});
