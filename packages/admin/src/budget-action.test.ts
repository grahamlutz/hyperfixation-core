import { fileURLToPath } from "node:url";
import { BudgetExceeded, createLlm, createProviders, fixedCost } from "@hyperfixation/ai";
import {
  AccessRefused,
  createSessionGuard,
  type AuthSession,
  type RequireSession,
} from "@hyperfixation/auth";
import { createStepPool, type StepPool } from "@hyperfixation/db";
import {
  asRole,
  createTestDatabase,
  MockLanguageModel,
  MOCK_MODEL_ID,
  type TestDatabase,
} from "@hyperfixation/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InvalidBudget, UnknownBudgetPeriod } from "./budget.js";
import { createAdminRouter } from "./router.js";

/** Resolved from this module, like `ai`'s own fixture directory, so cwd does not matter. */
const PROMPTS_DIR = fileURLToPath(new URL("test-support/prompts", import.meta.url));

/** The app's starting default, copied into the first period the gate opens. */
const APP_STATE_BUDGET = 0.01;

/** A period no gate will ever open, so the cheap tests cannot disturb the month's own row. */
const PAST_PERIOD = "1999-01";

const ADMIN_SESSION: AuthSession = {
  factor: "passkey",
  user: { id: "u-admin", email: "admin@app.test", role: "admin" },
};

const MEMBER_SESSION: AuthSession = {
  factor: "passkey",
  user: { id: "u-other", email: "other@app.test", role: "member" },
};

describe("editing a period's budget from the admin", () => {
  let database: TestDatabase;
  let pool: Pool;
  let steps: StepPool;
  let period: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, $1)", [
        APP_STATE_BUDGET,
      ]);
    });
    pool = new Pool({ connectionString: database.applicationUrl, max: 4 });
    steps = createStepPool({ connectionString: database.applicationUrl });

    await pool.query(
      "INSERT INTO hf_user (id, name, email, role) VALUES " +
        "('u-admin', 'Admin', 'admin@app.test', 'admin'), " +
        "('u-other', 'Other', 'other@app.test', 'member')",
    );
    const { rows } = await pool.query<{ period: string }>(
      "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') AS period",
    );
    period = rows[0]!.period;
  }, 60_000);

  afterAll(async () => {
    await steps?.end();
    await pool?.end();
    await database?.drop();
  });

  const routerFor = (current: AuthSession | null) => {
    const notFound = vi.fn();
    const requireSession: RequireSession = createSessionGuard({
      getSession: () => Promise.resolve(current),
      onNotFound: notFound,
      onRedirect: vi.fn(),
    });
    return { notFound, router: createAdminRouter({ pool, requireSession }) };
  };

  const budgetRow = async (which: string) => {
    const { rows } = await pool.query<{ budget: string; spent: string }>(
      "SELECT budget_usd::text AS budget, spent_usd::text AS spent FROM hf_budget_period " +
        "WHERE period = $1",
      [which],
    );
    return rows[0];
  };

  /**
   * One real gate: a fresh run, the ledger's own `createLlm` over a cassette, and a flat price
   * so the gate's arithmetic is the only thing under test.
   */
  const gate = async (runId: string, estimateUsd: number): Promise<unknown> => {
    await pool.query(
      "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
        "VALUES ($1, 'test', '{}', 'running', 1, $1)",
      [runId],
    );
    const model = new MockLanguageModel({ responses: [{ text: "ok" }] });
    const llm = createLlm({
      providers: createProviders({
        models: { [MOCK_MODEL_ID]: model },
        costs: { [MOCK_MODEL_ID]: fixedCost(estimateUsd, estimateUsd) },
      }),
      promptsDir: PROMPTS_DIR,
    });
    return llm.run(
      { runId, workflowId: runId, tx: (work) => steps.tx(runId, runId, work) },
      { key: "k", model: MOCK_MODEL_ID, prompt: "budget", input: {} },
    );
  };

  describe("the action itself", () => {
    beforeAll(async () => {
      await pool.query(
        "INSERT INTO hf_budget_period (period, budget_usd, spent_usd) VALUES ($1, 10, 5) " +
          "ON CONFLICT (period) DO NOTHING",
        [PAST_PERIOD],
      );
    });

    it("is refused for a member, and nothing is written", async () => {
      const { router, notFound } = routerFor(MEMBER_SESSION);

      await expect(
        router.actions.setBudget({ period: PAST_PERIOD, budgetUsd: 999 }),
      ).rejects.toBeInstanceOf(AccessRefused);
      expect(notFound).toHaveBeenCalledTimes(1);
      expect(await budgetRow(PAST_PERIOD)).toMatchObject({ budget: "10.0000" });
      await expect(auditRowsFor(PAST_PERIOD)).resolves.toEqual([]);
    });

    it("writes budget_usd for an admin and leaves spent_usd and hf_app_state alone", async () => {
      const { router } = routerFor(ADMIN_SESSION);

      await expect(
        router.actions.setBudget({ period: PAST_PERIOD, budgetUsd: 42.5, reason: "raised" }),
      ).resolves.toEqual({
        period: PAST_PERIOD,
        budgetUsd: "42.5000",
        previousBudgetUsd: "10.0000",
        spentUsd: "5.0000",
      });

      expect(await budgetRow(PAST_PERIOD)).toEqual({ budget: "42.5000", spent: "5.0000" });
      const { rows } = await pool.query<{ budget: string }>(
        "SELECT budget_usd::text AS budget FROM hf_app_state WHERE id = 1",
      );
      expect(rows[0]?.budget).toBe("0.0100");
    });

    it("audits the change with the admin from the session and both values", async () => {
      const { router } = routerFor(ADMIN_SESSION);
      await router.actions.setBudget({
        period: PAST_PERIOD,
        budgetUsd: 7,
        actorId: "u-other",
        reason: "cut",
      });

      const rows = await auditRowsFor(PAST_PERIOD);
      expect(rows.at(-1)).toEqual({
        actor_id: "u-admin",
        action: "app.budget_set",
        target_type: "hf_budget_period",
        target_id: PAST_PERIOD,
        meta: {
          previousBudgetUsd: "42.5000",
          budgetUsd: "7.0000",
          spentUsd: "5.0000",
          reason: "cut",
        },
      });
    });

    it("refuses a budget that is not a finite, non-negative number", async () => {
      const { router } = routerFor(ADMIN_SESSION);

      for (const budgetUsd of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(
          router.actions.setBudget({ period: PAST_PERIOD, budgetUsd }),
        ).rejects.toBeInstanceOf(InvalidBudget);
      }
      expect(await budgetRow(PAST_PERIOD)).toMatchObject({ budget: "7.0000" });
    });

    it("refuses a period that has no row rather than creating one", async () => {
      const { router } = routerFor(ADMIN_SESSION);

      await expect(
        router.actions.setBudget({ period: "1998-01", budgetUsd: 1 }),
      ).rejects.toBeInstanceOf(UnknownBudgetPeriod);
      expect(await budgetRow("1998-01")).toBeUndefined();
    });
  });

  describe("what the next gate reads", () => {
    it("takes effect at the next gate: the call the old budget refused now goes through", async () => {
      // The month's row does not exist until a gate opens it, from hf_app_state's 0.01.
      await expect(gate("b-first", APP_STATE_BUDGET)).resolves.toEqual({ text: "ok" });
      expect(await budgetRow(period)).toEqual({ budget: "0.0100", spent: "0.0100" });

      // 0.0100 spent + 0.0100 estimated is over the 0.0100 ceiling.
      await expect(gate("b-refused", APP_STATE_BUDGET)).rejects.toBeInstanceOf(BudgetExceeded);

      const { router } = routerFor(ADMIN_SESSION);
      await expect(router.actions.setBudget({ period, budgetUsd: 1 })).resolves.toMatchObject({
        budgetUsd: "1.0000",
        previousBudgetUsd: "0.0100",
      });

      await expect(gate("b-after", APP_STATE_BUDGET)).resolves.toEqual({ text: "ok" });
      expect(await budgetRow(period)).toEqual({ budget: "1.0000", spent: "0.0200" });
    });

    it("is the kill lever below what the period already spent: the next gate refuses", async () => {
      const before = await budgetRow(period);
      const { router } = routerFor(ADMIN_SESSION);

      // Deliberately allowed. It does not unspend anything; it stops the next call.
      await expect(router.actions.setBudget({ period, budgetUsd: 0 })).resolves.toMatchObject({
        budgetUsd: "0.0000",
        spentUsd: before!.spent,
      });

      await expect(gate("b-killed", 0.0001)).rejects.toBeInstanceOf(BudgetExceeded);
      expect(await budgetRow(period)).toEqual({ budget: "0.0000", spent: before!.spent });
    });
  });

  async function auditRowsFor(target: string): Promise<Record<string, unknown>[]> {
    const { rows } = await pool.query<Record<string, unknown>>(
      "SELECT actor_id, action, target_type, target_id, meta FROM hf_audit " +
        "WHERE target_id = $1 ORDER BY id",
      [target],
    );
    return rows;
  }
});
