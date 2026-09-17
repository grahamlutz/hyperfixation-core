import { createStepPool, type StepPool } from "@hyperfixation/db";
import { asRole, createTestDatabase, MockLanguageModel, type TestDatabase } from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppPaused, BudgetExceeded, LedgerKeyCollision } from "./errors.js";
import { hashInput } from "./input-hash.js";
import { llm, type LedgerContext } from "./llm-run.js";

/** The gate's five branches, driven straight through `ctx.tx` with no worker in the picture. */
describe("the gate's branches", () => {
  let database: TestDatabase;
  let steps: StepPool;

  beforeAll(async () => {
    database = await createTestDatabase();
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, 100)");
    });
    steps = createStepPool({ connectionString: database.applicationUrl });
  }, 60_000);

  afterAll(async () => {
    await steps?.end();
    await database?.drop();
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

  async function rowOf(runId: string, key: string): Promise<Record<string, unknown> | undefined> {
    return asRole(database.applicationUrl, async (pg) => {
      const { rows } = await pg.query(
        "SELECT * FROM hf_llm_call WHERE run_id = $1 AND key = $2",
        [runId, key],
      );
      return rows[0];
    });
  }

  it("refuses a second call on the same key with a different input", async () => {
    const ctx = await context("branch-collision");
    const model = new MockLanguageModel({ responses: [{ text: "one" }] });
    const call = { key: "k", prompt: "p", estimatedCostUsd: 0.01, model };

    await expect(llm.run(ctx, { ...call, input: { a: 1 } })).resolves.toEqual({ text: "one" });
    await expect(llm.run(ctx, { ...call, input: { a: 2 } })).rejects.toBeInstanceOf(
      LedgerKeyCollision,
    );
    expect(model.callCount).toBe(1);
  });

  it("serves an ok row from the ledger without calling the provider again", async () => {
    const ctx = await context("branch-ok");
    const model = new MockLanguageModel({ responses: [{ text: "cached" }] });
    const call = { key: "k", prompt: "p", input: { a: 1 }, estimatedCostUsd: 0.01, model };

    await expect(llm.run(ctx, call)).resolves.toEqual({ text: "cached" });
    await expect(llm.run(ctx, call)).resolves.toEqual({ text: "cached" });
    expect(model.callCount).toBe(1);
    expect(await rowOf("branch-ok", "k")).toMatchObject({
      status: "ok",
      possible_double_charge: false,
    });
  });

  it("rethrows an error row instead of retrying the call", async () => {
    const ctx = await context("branch-error");
    const model = new MockLanguageModel({ responses: [{ error: new Error("provider exploded") }] });
    const call = { key: "k", prompt: "p", input: { a: 1 }, estimatedCostUsd: 0.01, model };

    await expect(llm.run(ctx, call)).rejects.toThrow("provider exploded");
    expect(await rowOf("branch-error", "k")).toMatchObject({ status: "error", cost_usd: null });

    await expect(llm.run(ctx, call)).rejects.toThrow("provider exploded");
    expect(model.callCount).toBe(1);
  });

  it("flags a started row left by another attempt as a possible double charge", async () => {
    const ctx = await context("branch-crashed");
    const model = new MockLanguageModel({ responses: [{ text: "second" }] });
    const input = { a: 1 };
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query(
        `INSERT INTO hf_llm_call
           (run_id, key, workflow_id, period, input_hash, status, estimated_cost_usd)
         VALUES ('branch-crashed', 'k', 'branch-crashed:9',
                 to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), $1, 'started', 0.01)`,
        [hashInput(input)],
      );
    });

    await expect(
      llm.run(ctx, { key: "k", prompt: "p", input, estimatedCostUsd: 0.01, model }),
    ).resolves.toEqual({ text: "second" });

    expect(model.callCount).toBe(1);
    expect(await rowOf("branch-crashed", "k")).toMatchObject({
      status: "ok",
      possible_double_charge: true,
      workflow_id: "branch-crashed",
    });
  });

  it("refuses a call that does not fit the period's budget, leaving no row behind", async () => {
    const ctx = await context("branch-budget");
    const model = new MockLanguageModel({ responses: [{ text: "never" }] });

    await expect(
      llm.run(ctx, { key: "k", prompt: "p", input: {}, estimatedCostUsd: 1000, model }),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(model.callCount).toBe(0);
    expect(await rowOf("branch-budget", "k")).toBeUndefined();
  });

  it("refuses to call the provider while the app is paused", async () => {
    const ctx = await context("branch-paused");
    const model = new MockLanguageModel({ responses: [{ text: "never" }] });
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query("UPDATE hf_app_state SET paused = true WHERE id = 1");
    });

    try {
      await expect(
        llm.run(ctx, { key: "k", prompt: "p", input: {}, estimatedCostUsd: 0.01, model }),
      ).rejects.toBeInstanceOf(AppPaused);
      expect(model.callCount).toBe(0);
      expect(await rowOf("branch-paused", "k")).toBeUndefined();
    } finally {
      await asRole(database.applicationUrl, async (pg) => {
        await pg.query("UPDATE hf_app_state SET paused = false WHERE id = 1");
      });
    }
  });
});
