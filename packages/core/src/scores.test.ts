import { createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeScore } from "./scores.js";
import { defineSpec } from "./specs.js";

let database: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = new Pool({ max: 2, connectionString: database.applicationUrl });
}, 120_000);

afterAll(async () => {
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
});
