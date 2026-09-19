import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStepPool, type StepPool } from "@hyperfixation/db";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLlm, type LedgerContext } from "./llm-run.js";
import { createProviders } from "./providers.js";

/** A run with no API key is still a fully ledgered run — it just bills nothing. */
describe("a fixture-served call", () => {
  let database: TestDatabase;
  let steps: StepPool;
  let promptsDir: string;
  let fixturesDir: string;

  beforeAll(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    database = await createTestDatabase();
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, 100)");
    });
    steps = createStepPool({ connectionString: database.applicationUrl });
    promptsDir = await mkdtemp(path.join(tmpdir(), "hf-fixture-prompts-"));
    fixturesDir = await mkdtemp(path.join(tmpdir(), "hf-fixture-llm-"));
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await steps?.end();
    await database?.drop();
    if (promptsDir !== undefined) await rm(promptsDir, { recursive: true, force: true });
    if (fixturesDir !== undefined) await rm(fixturesDir, { recursive: true, force: true });
  });

  async function context(runId: string): Promise<LedgerContext> {
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query(
        "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
          "VALUES ($1, 'test', '{}', 'running', 1, $1)",
        [runId],
      );
    });
    return { runId, workflowId: runId, tx: (work) => steps.tx(runId, runId, work) };
  }

  it("writes an ok row at cost 0 with the prompt's hash, and leaves spent_usd alone", async () => {
    const promptText = "draft a reply\n";
    await writeFile(path.join(promptsDir, "draft.md"), promptText);
    await writeFile(
      path.join(fixturesDir, "draft.json"),
      JSON.stringify({
        responses: [
          { when: { userTextIncludes: "acme roofing" }, text: "Dear Acme" },
          { text: "Dear customer" },
        ],
      }),
    );
    const ctx = await context("fixture-ledger");
    const llm = createLlm({
      providers: createProviders({ fixtures: { dir: fixturesDir } }),
      promptsDir,
    });

    const answer = await llm.run(ctx, {
      key: "draft:1",
      model: "claude-sonnet-4-5",
      prompt: "draft",
      input: { name: "Acme Roofing" },
    });
    expect(answer).toEqual({ text: "Dear Acme" });

    const row = await asRole(database.applicationUrl, async (pg) => {
      const { rows } = await pg.query(
        "SELECT status, model, prompt_name, prompt_hash, cost_usd, tokens_in, tokens_out " +
          "FROM hf_llm_call WHERE run_id = $1 AND key = $2",
        ["fixture-ledger", "draft:1"],
      );
      return rows[0] as Record<string, unknown>;
    });
    expect(row).toMatchObject({
      status: "ok",
      model: "claude-sonnet-4-5",
      prompt_name: "draft",
      prompt_hash: createHash("sha256").update(promptText).digest("hex"),
      tokens_in: 0,
      tokens_out: 0,
    });
    expect(Number(row["cost_usd"])).toBe(0);

    const spent = await asRole(database.applicationUrl, async (pg) => {
      const { rows } = await pg.query("SELECT spent_usd FROM hf_budget_period");
      return Number((rows[0] as { spent_usd: string }).spent_usd);
    });
    expect(spent).toBe(0);
  });
});
