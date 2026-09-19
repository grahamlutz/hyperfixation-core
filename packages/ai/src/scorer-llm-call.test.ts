import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createRegistry,
  defineScorer,
  defineSpec,
  writeStepScore,
  type Scored,
} from "@hyperfixation/core";
import { createStepPool, type RecordTable, type StepPool } from "@hyperfixation/db";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import type { StepContext } from "@hyperfixation/workflows";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLlm } from "./llm-run.js";
import { createProviders } from "./providers.js";

const RECORD_TYPE = "business";
const RECORD_TABLE = "businesses";
const RUN_ID = "scorer-llm-call";

interface Business {
  id: string;
  name: string;
}

const spec = defineSpec({ name: "buy-box", version: 1, criteria: { minMargin: 0.2 } });

/** What a template's LLM scorer looks like once `onCall` gives it the ledger row. */
const scorer = (llm: ReturnType<typeof createLlm>) =>
  defineScorer<Business, { minMargin: number }>({
    name: "buy-box",
    recordType: RECORD_TYPE,
    spec,
    async score(record, criteria, ctx): Promise<Scored> {
      let llmCallId: number | undefined;
      const answer = await llm.run<{ score: number; explanation: string }>(ctx, {
        key: `score:${record.id}`,
        model: "claude-sonnet-4-5",
        prompt: "score",
        input: { name: record.name, minMargin: criteria.minMargin },
        schema: {
          type: "object",
          properties: { score: { type: "number" }, explanation: { type: "string" } },
          required: ["score", "explanation"],
        },
        onCall: (call) => {
          llmCallId = call.id;
        },
      });
      return { score: answer.score, explanation: answer.explanation, llmCallId };
    },
  });

describe("an LLM-assigned score", () => {
  let database: TestDatabase;
  let steps: StepPool;
  let promptsDir: string;
  let fixturesDir: string;

  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    database = await createTestDatabase();
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, 100)");
      await pg.query(
        `CREATE TABLE ${RECORD_TABLE} (
           id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
           name text NOT NULL,
           score double precision,
           score_explanation text,
           spec_version integer)`,
      );
      await pg.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${RECORD_TABLE} TO ${database.roles.application}`,
      );
    });
    steps = createStepPool({ connectionString: database.applicationUrl });
    promptsDir = await mkdtemp(path.join(tmpdir(), "hf-scorer-prompts-"));
    fixturesDir = await mkdtemp(path.join(tmpdir(), "hf-scorer-llm-"));
    await writeFile(path.join(promptsDir, "score.md"), "score the business\n");
    await writeFile(
      path.join(fixturesDir, "score.json"),
      JSON.stringify({ responses: [{ json: { score: 0.8, explanation: "margin clears" } }] }),
    );
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await steps?.end();
    await database?.drop();
    if (promptsDir !== undefined) await rm(promptsDir, { recursive: true, force: true });
    if (fixturesDir !== undefined) await rm(fixturesDir, { recursive: true, force: true });
  });

  it("points hf_score.llm_call_id at the hf_llm_call row the fixture answered", async () => {
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query(
        "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
          "VALUES ($1, 'test', '{}', 'running', 1, $1)",
        [RUN_ID],
      );
    });
    const record = await asRole(database.applicationUrl, async (pg) => {
      const { rows } = await pg.query<Business>(
        `INSERT INTO ${RECORD_TABLE} (name) VALUES ('Acme Roofing') RETURNING id, name`,
      );
      return rows[0]!;
    });
    const ctx: StepContext = {
      runId: RUN_ID,
      attempt: 1,
      workflowId: RUN_ID,
      key: `score:${record.id}`,
      tx: (work) => steps.tx(RUN_ID, RUN_ID, work),
    };

    const records = createRegistry<RecordTable>("record type", (entry) => entry.recordType);
    records.register({ table: RECORD_TABLE, recordType: RECORD_TYPE });
    const llm = createLlm({
      providers: createProviders({ fixtures: { dir: fixturesDir } }),
      promptsDir,
    });

    const scored = await scorer(llm).score(record, spec.criteria, ctx);
    await writeStepScore(ctx, records, {
      recordType: RECORD_TYPE,
      recordId: record.id,
      spec,
      ...scored,
    });

    const row = await asRole(database.applicationUrl, async (pg) => {
      const { rows } = await pg.query<{ score: number; llm_call_id: string | null; key: string }>(
        "SELECT s.score, s.llm_call_id, c.key FROM hf_score s " +
          "JOIN hf_llm_call c ON c.id = s.llm_call_id WHERE s.record_id = $1",
        [record.id],
      );
      return rows[0];
    });

    expect(row).toMatchObject({ score: 0.8, key: `score:${record.id}` });
    expect(row?.llm_call_id).not.toBeNull();
  });
});
