import { ADMIN_URL, asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AppStateUnseeded,
  budgetApp,
  budgetLines,
  BUDGET_DEFAULT_SET_ACTION,
  InvalidBudget,
  OPERATOR_ENV,
  type BudgetAppOptions,
} from "./budget.js";
import { main } from "./cli.js";
import { openDatabaseUrl } from "./database.js";

const PERIOD = "2026-09";
const OPERATOR = "graham";

describe("hf budget", () => {
  let db: TestDatabase;

  /** The cluster as the tunnel hands it over: the admin URL, opened per call and closed after. */
  const cluster = (): BudgetAppOptions["database"] => () =>
    Promise.resolve(openDatabaseUrl(ADMIN_URL));

  const query = async <Row extends Record<string, unknown>>(sql: string): Promise<Row[]> =>
    (await asRole(db.migratorUrl, (pg) => pg.query<Row>(sql))).rows;

  beforeAll(async () => {
    db = await createTestDatabase();
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await asRole(db.migratorUrl, async (pg) => {
      await pg.query("DELETE FROM hf_audit");
      await pg.query("DELETE FROM hf_app_state");
      await pg.query("DELETE FROM hf_budget_period");
      await pg.query("INSERT INTO hf_app_state (id, budget_usd) VALUES (1, '10')");
      await pg.query(
        "INSERT INTO hf_budget_period (period, budget_usd, spent_usd) " +
          `VALUES ('${PERIOD}', '10', '4.5')`,
      );
    });
  });

  it("moves the default, leaves the running period alone, and names the operator in hf_audit", async () => {
    const result = await budgetApp({
      app: db.appName,
      budgetUsd: "25",
      database: cluster(),
      operator: OPERATOR,
      env: {},
    });

    expect(result).toEqual({
      app: db.appName,
      previousBudgetUsd: "10.0000",
      budgetUsd: "25.0000",
      operator: OPERATOR,
    });

    expect(await query<{ budget_usd: string }>("SELECT budget_usd FROM hf_app_state")).toEqual([
      { budget_usd: "25.0000" },
    ]);
    // The month already running is the admin form's to change; this command must not have touched
    // either of its columns.
    expect(
      await query<{ budget_usd: string; spent_usd: string }>(
        "SELECT budget_usd, spent_usd FROM hf_budget_period",
      ),
    ).toEqual([{ budget_usd: "10.0000", spent_usd: "4.500000" }]);

    const audit = await query<{
      actor_id: string;
      action: string;
      target_type: string;
      target_id: string;
      meta: { operator: string; previousBudgetUsd: string; budgetUsd: string };
    }>("SELECT actor_id, action, target_type, target_id, meta FROM hf_audit");
    expect(audit).toEqual([
      {
        actor_id: `hf-cli:${OPERATOR}`,
        action: BUDGET_DEFAULT_SET_ACTION,
        target_type: "hf_app_state",
        target_id: "1",
        meta: {
          operator: OPERATOR,
          previousBudgetUsd: "10.0000",
          budgetUsd: "25.0000",
        },
      },
    ]);
  }, 30_000);

  it("takes the operator from HF_OPERATOR when none is passed", async () => {
    const result = await budgetApp({
      app: db.appName,
      budgetUsd: "12.5",
      database: cluster(),
      env: { [OPERATOR_ENV]: "ci-bot" },
    });

    expect(result.operator).toBe("ci-bot");
    expect(
      await query<{ actor_id: string }>("SELECT actor_id FROM hf_audit"),
    ).toEqual([{ actor_id: "hf-cli:ci-bot" }]);
  }, 30_000);

  it("falls back to the login name when HF_OPERATOR is set to nothing", async () => {
    const result = await budgetApp({
      app: db.appName,
      budgetUsd: "12.5",
      database: cluster(),
      env: { [OPERATOR_ENV]: "" },
    });

    // Whatever this machine's login name is, it is not the empty string: an audit row reading
    // `hf-cli:` names nobody.
    expect(result.operator).not.toBe("");
    expect(
      await query<{ actor_id: string }>("SELECT actor_id FROM hf_audit"),
    ).toEqual([{ actor_id: `hf-cli:${result.operator}` }]);
  }, 30_000);

  it("refuses an amount that is not a positive number, before it opens anything", async () => {
    for (const budgetUsd of ["0", "-5", "lots", ""]) {
      await expect(
        budgetApp({
          app: db.appName,
          budgetUsd,
          database: () => Promise.reject(new Error("the tunnel must not be opened")),
          env: {},
        }),
      ).rejects.toThrow(InvalidBudget);
    }

    expect(await query<{ budget_usd: string }>("SELECT budget_usd FROM hf_app_state")).toEqual([
      { budget_usd: "10.0000" },
    ]);
  }, 30_000);

  it("writes nothing at all when the app has no hf_app_state row to edit", async () => {
    await asRole(db.migratorUrl, async (pg) => {
      await pg.query("DELETE FROM hf_app_state");
    });

    await expect(
      budgetApp({ app: db.appName, budgetUsd: "25", database: cluster(), env: {} }),
    ).rejects.toThrow(AppStateUnseeded);

    expect(await query<{ n: string }>("SELECT count(*)::text AS n FROM hf_audit")).toEqual([
      { n: "0" },
    ]);
  }, 30_000);

  it("prints what moved and what did not", () => {
    expect(
      budgetLines({
        app: "demo-app",
        previousBudgetUsd: "10.0000",
        budgetUsd: "25.0000",
        operator: OPERATOR,
      }),
    ).toEqual([
      `demo-app: hf_app_state.budget_usd $10.0000 → $25.0000, audited as ` +
        `${BUDGET_DEFAULT_SET_ACTION} by ${OPERATOR}`,
      "demo-app: the running period keeps its own ceiling — change that in the admin budget form",
    ]);
  });

  it("needs a name and an amount through main", async () => {
    const err: string[] = [];
    const code = await main(["budget", "demo-app"], {
      out: () => undefined,
      err: (line) => err.push(line),
    });

    expect(code).toBe(1);
    expect(err[0]).toContain("hf budget needs a name and an amount");
  });
});
