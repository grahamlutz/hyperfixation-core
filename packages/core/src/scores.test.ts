import { checkE002, createStepPool, type RecordTable, type StepPool } from "@hyperfixation/db";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import type { StepContext } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRegistry, UnknownRegistration, type Registry } from "./registry.js";
import { latestScores, writeScore, writeStepScore } from "./scores.js";
import { defineSpec } from "./specs.js";

const RECORD_TYPE = "business";
const RECORD_TABLE = "businesses";
const REGISTERED: RecordTable[] = [{ table: RECORD_TABLE, recordType: RECORD_TYPE }];

let database: TestDatabase;
let pool: Pool;
let steps: StepPool;
let records: Registry<RecordTable>;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = new Pool({ max: 2, connectionString: database.applicationUrl });
  steps = createStepPool({ connectionString: database.applicationUrl });
  records = createRegistry<RecordTable>("record type", (entry) => entry.recordType);
  for (const record of REGISTERED) records.register(record);

  // Shaped like `hfRecordColumns()`; the three score columns are what `scores.write` updates.
  await asRole(database.migratorUrl, async (pg) => {
    await pg.query(
      `CREATE TABLE ${RECORD_TABLE} (
         id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         name text NOT NULL,
         stage text,
         score double precision,
         score_explanation text,
         spec_version integer,
         normalized_name text)`,
    );
    await pg.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${RECORD_TABLE} TO ${database.roles.application}`,
    );
  });
}, 120_000);

afterAll(async () => {
  await steps?.end();
  await pool?.end();
  await database?.drop();
});

describe("writeScore()", () => {
  it("adds a row per scoring and leaves an earlier spec version's row standing", async () => {
    const v1 = defineSpec({ name: "buy-box", version: 1, criteria: { minMargin: 0.2 } });
    const v2 = defineSpec({ name: "buy-box", version: 2, criteria: { minMargin: 0.3 } });

    const first = await writeScore(pool, {
      recordType: "business",
      recordId: 42,
      spec: v1,
      score: 0.8,
      explanation: "margin clears",
      llmCallId: 7,
    });
    const second = await writeScore(pool, {
      recordType: "business",
      recordId: 42,
      spec: v2,
      score: 0.4,
    });

    expect(second.id).toBeGreaterThan(first.id);

    const { rows } = await pool.query<{
      id: string;
      spec_version: number;
      score: number;
      explanation: string | null;
      llm_call_id: string | null;
    }>(
      "SELECT id, spec_version, score, explanation, llm_call_id FROM hf_score " +
        "WHERE record_type = $1 AND record_id = $2 ORDER BY id",
      ["business", "42"],
    );

    expect(rows).toHaveLength(2);
    // Version 1's row is untouched: a new version scores again, it does not restate the old score.
    expect(rows[0]).toMatchObject({
      id: String(first.id),
      spec_version: 1,
      score: 0.8,
      explanation: "margin clears",
      llm_call_id: "7",
    });
    expect(rows[1]).toMatchObject({
      id: String(second.id),
      spec_version: 2,
      score: 0.4,
      explanation: null,
      llm_call_id: null,
    });
  });

  it("keeps two specs' scores of one record apart, and latest per spec", async () => {
    const buyBox = defineSpec({ name: "buy-box", version: 1, criteria: {} });
    const risk = defineSpec({ name: "risk", version: 4, criteria: {} });

    await writeScore(pool, { recordType: "business", recordId: 77, spec: buyBox, score: 0.1 });
    await writeScore(pool, { recordType: "business", recordId: 77, spec: risk, score: 0.2 });
    await writeScore(pool, { recordType: "business", recordId: 77, spec: buyBox, score: 0.9 });

    const { rows } = await pool.query<{ spec_name: string; score: number }>(
      "SELECT spec_name, score FROM hf_score WHERE record_id = $1 ORDER BY id",
      ["77"],
    );
    expect(rows).toEqual([
      { spec_name: "buy-box", score: 0.1 },
      { spec_name: "risk", score: 0.2 },
      { spec_name: "buy-box", score: 0.9 },
    ]);

    // `risk`'s answer is its own: `buy-box` scoring again does not supersede it.
    const latest = await latestScores(pool, { recordType: "business", recordId: 77 });
    expect(latest.map((row) => [row.specName, row.specVersion, row.score])).toEqual([
      ["buy-box", 1, 0.9],
      ["risk", 4, 0.2],
    ]);
  });
});

describe("scores.write (step-side)", () => {
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

  async function insertRecord(name: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO ${RECORD_TABLE} (name) VALUES ($1) RETURNING id`,
      [name],
    );
    return rows[0]!.id;
  }

  it("writes the row, the record's columns and the timeline entry, once per (run, key)", async () => {
    const spec = defineSpec({ name: "buy-box", version: 3, criteria: { minMargin: 0.2 } });
    const recordId = await insertRecord("scored");

    const first = await writeStepScore(await context("score-replay", "score"), records, {
      recordType: RECORD_TYPE,
      recordId,
      spec,
      score: 0.9,
      explanation: "clears every gate",
    });
    expect(first).toMatchObject({ created: true });

    const second = await writeStepScore(await context("score-replay", "score", 2), records, {
      recordType: RECORD_TYPE,
      recordId,
      spec,
      score: 0.9,
      explanation: "clears every gate",
    });
    expect(second).toEqual({ id: first.id, created: false });

    const scores = await pool.query<{ id: string; run_id: string | null; key: string | null }>(
      "SELECT id, run_id, key FROM hf_score WHERE record_type = $1 AND record_id = $2 ORDER BY id",
      [RECORD_TYPE, recordId],
    );
    expect(scores.rows).toHaveLength(1);
    expect(scores.rows[0]).toMatchObject({ run_id: "score-replay", key: "score" });

    const record = await pool.query<Record<string, unknown>>(
      `SELECT score, score_explanation, spec_version FROM ${RECORD_TABLE} WHERE id = $1`,
      [recordId],
    );
    expect(record.rows[0]).toMatchObject({
      score: 0.9,
      score_explanation: "clears every gate",
      spec_version: 3,
    });

    const activity = await pool.query<{ kind: string; key: string | null }>(
      "SELECT kind, key FROM hf_activity WHERE run_id = $1 ORDER BY id",
      ["score-replay"],
    );
    expect(activity.rows).toEqual([
      { kind: "score.written", key: "score:score.written:buy-box" },
    ]);
    await expect(checkE002(pool, REGISTERED)).resolves.toBeUndefined();
  });

  it("adds a row per spec version and moves the record's columns to the newest", async () => {
    const v1 = defineSpec({ name: "buy-box", version: 1, criteria: {} });
    const v2 = defineSpec({ name: "buy-box", version: 2, criteria: {} });
    const recordId = await insertRecord("rescored");

    await writeStepScore(await context("score-v1", "score"), records, {
      recordType: RECORD_TYPE,
      recordId,
      spec: v1,
      score: 0.3,
    });
    await writeStepScore(await context("score-v2", "score"), records, {
      recordType: RECORD_TYPE,
      recordId,
      spec: v2,
      score: 0.7,
    });

    const { rows } = await pool.query<{ spec_version: number; score: number }>(
      "SELECT spec_version, score FROM hf_score WHERE record_id = $1 ORDER BY id",
      [recordId],
    );
    expect(rows).toEqual([
      { spec_version: 1, score: 0.3 },
      { spec_version: 2, score: 0.7 },
    ]);

    const record = await pool.query<{ score: number; spec_version: number }>(
      `SELECT score, spec_version FROM ${RECORD_TABLE} WHERE id = $1`,
      [recordId],
    );
    expect(record.rows[0]).toEqual({ score: 0.7, spec_version: 2 });
  });

  it("writes both specs one step scores under the same key, and neither twice on a replay", async () => {
    const buyBox = defineSpec({ name: "buy-box", version: 1, criteria: {} });
    const risk = defineSpec({ name: "risk", version: 2, criteria: {} });
    const recordId = await insertRecord("two specs");

    const both = async (attempt: number): Promise<void> => {
      for (const spec of [buyBox, risk]) {
        await writeStepScore(await context("score-two-specs", "score", attempt), records, {
          recordType: RECORD_TYPE,
          recordId,
          spec,
          score: spec === buyBox ? 0.6 : 0.4,
        });
      }
    };
    await both(1);
    await both(2);

    const { rows } = await pool.query<{ spec_name: string; score: number; key: string }>(
      "SELECT spec_name, score, key FROM hf_score WHERE record_id = $1 ORDER BY id",
      [recordId],
    );
    expect(rows).toEqual([
      { spec_name: "buy-box", score: 0.6, key: "score" },
      { spec_name: "risk", score: 0.4, key: "score" },
    ]);

    const activity = await pool.query<{ key: string }>(
      "SELECT key FROM hf_activity WHERE run_id = $1 ORDER BY id",
      ["score-two-specs"],
    );
    expect(activity.rows.map((row) => row.key)).toEqual([
      "score:score.written:buy-box",
      "score:score.written:risk",
    ]);
  });

  it("refuses a record type this app never registered", async () => {
    const spec = defineSpec({ name: "buy-box", version: 1, criteria: {} });
    await expect(
      writeStepScore(await context("score-ghost", "score"), records, {
        recordType: "ghost",
        recordId: 1,
        spec,
        score: 0.1,
      }),
    ).rejects.toBeInstanceOf(UnknownRegistration);
  });
});
