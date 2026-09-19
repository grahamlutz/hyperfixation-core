import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createStepPool, type StepPool } from "@hyperfixation/db";
import {
  asRole,
  createTestDatabase,
  MockLanguageModel,
  MOCK_MODEL_ID,
  type TestDatabase,
} from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LedgerKeyCollision, UnknownPrompt } from "./errors.js";
import { createLlm, type LedgerContext, type Llm } from "./llm-run.js";
import { createProviders, fixedCost } from "./providers.js";

/** The prompt file is the prompt: what lands on the row is the hash of the bytes just read. */
describe("prompt files", () => {
  let database: TestDatabase;
  let steps: StepPool;
  let promptsDir: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, 100)");
    });
    steps = createStepPool({ connectionString: database.applicationUrl });
    promptsDir = await mkdtemp(path.join(tmpdir(), "hf-prompts-"));
  }, 60_000);

  afterAll(async () => {
    await steps?.end();
    await database?.drop();
    if (promptsDir !== undefined) await rm(promptsDir, { recursive: true, force: true });
  });

  function ledger(model: LanguageModelV4): Llm {
    return createLlm({
      providers: createProviders({
        models: { [MOCK_MODEL_ID]: model },
        costs: { [MOCK_MODEL_ID]: fixedCost(0.01, 0.01) },
      }),
      promptsDir,
    });
  }

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

  async function rowOf(runId: string, key: string): Promise<Record<string, unknown> | undefined> {
    return asRole(database.applicationUrl, async (pg) => {
      const { rows } = await pg.query(
        "SELECT * FROM hf_llm_call WHERE run_id = $1 AND key = $2",
        [runId, key],
      );
      return rows[0];
    });
  }

  async function write(name: string, text: string): Promise<string> {
    await writeFile(path.join(promptsDir, `${name}.md`), text);
    return createHash("sha256").update(text).digest("hex");
  }

  it("records the name and the sha256 of the bytes it read", async () => {
    const ctx = await context("prompt-hash");
    const hash = await write("draft", "draft one line\n");
    const model = new MockLanguageModel({ responses: [{ text: "one" }] });

    await ledger(model).run(ctx, { key: "k", model: MOCK_MODEL_ID, prompt: "draft", input: {} });

    expect(await rowOf("prompt-hash", "k")).toMatchObject({
      prompt_name: "draft",
      prompt_hash: hash,
    });
  });

  it("hashes the edited file on the next key, and serves the old key from the row", async () => {
    const ctx = await context("prompt-edited");
    const first = await write("edited", "version one\n");
    const model = new MockLanguageModel({ responses: [{ text: "one" }, { text: "two" }] });
    const llm = ledger(model);
    const call = { model: MOCK_MODEL_ID, prompt: "edited", input: { a: 1 } };

    await llm.run(ctx, { ...call, key: "before" });
    const second = await write("edited", "version two\n");
    expect(second).not.toBe(first);

    await llm.run(ctx, { ...call, key: "after" });
    expect(await rowOf("prompt-edited", "after")).toMatchObject({ prompt_hash: second });

    // The prompt hash is recorded, not fenced: the same key and input is still a cache hit, and
    // the row keeps the hash of the bytes the answer actually came from.
    await expect(llm.run(ctx, { ...call, key: "before" })).resolves.toEqual({ text: "one" });
    expect(model.callCount).toBe(2);
    expect(await rowOf("prompt-edited", "before")).toMatchObject({ prompt_hash: first });
  });

  it("still refuses the same key with a different input", async () => {
    const ctx = await context("prompt-collision");
    await write("collide", "unchanged\n");
    const model = new MockLanguageModel({ responses: [{ text: "one" }] });
    const llm = ledger(model);
    const call = { key: "k", model: MOCK_MODEL_ID, prompt: "collide" };

    await llm.run(ctx, { ...call, input: { a: 1 } });
    await expect(llm.run(ctx, { ...call, input: { a: 2 } })).rejects.toBeInstanceOf(
      LedgerKeyCollision,
    );
    expect(model.callCount).toBe(1);
  });

  it("refuses a name with no file, leaving no row and making no call", async () => {
    const ctx = await context("prompt-missing");
    const model = new MockLanguageModel({ responses: [{ text: "never" }] });

    await expect(
      ledger(model).run(ctx, { key: "k", model: MOCK_MODEL_ID, prompt: "absent", input: {} }),
    ).rejects.toBeInstanceOf(UnknownPrompt);
    expect(model.callCount).toBe(0);
    expect(await rowOf("prompt-missing", "k")).toBeUndefined();
  });
});
