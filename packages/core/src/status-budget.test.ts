/**
 * What `/api/status` says about a period whose counter agrees with its ledger. Before 0009 a
 * month of sub-cent calls could not agree: `spent_usd` was `numeric(12,4)` and `cost_usd`
 * `numeric(12,6)`, so the X1 box reported `spentUsd "0.0017"` against `ledgerUsd "0.001693"` and
 * went `degraded` on a drift of $0.000007 that was only the column's scale.
 */
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { getClient, resetClient } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appStatus } from "./status.js";

/** The X1 calls: 488/70 and 485/74 tokens of Haiku 4.5, at $1 and $5 per MTok. */
const COSTS = ["0.000838", "0.000855"];
const LEDGER_USD = "0.001693";

describe("the status report's budget drift", () => {
  let database: TestDatabase;
  let pool: Pool;
  let period: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = new Pool({ max: 4, connectionString: database.applicationUrl });
    await getClient({
      appName: database.appName,
      databaseUrl: database.applicationUrl,
    });
    const { rows } = await pool.query<{ period: string }>(
      "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') AS period",
    );
    period = rows[0]!.period;
  }, 120_000);

  afterAll(async () => {
    await resetClient();
    await pool?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query("DELETE FROM hf_llm_call");
      await pg.query("DELETE FROM hf_budget_period");
      await pg.query("DELETE FROM hf_app_state");
      await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, '100')");
    });
    await pool.query(
      "INSERT INTO hf_budget_period (period, budget_usd, spent_usd) VALUES ($1, '100', $2)",
      [period, LEDGER_USD],
    );
    for (const [i, cost] of COSTS.entries()) {
      await pool.query(
        "INSERT INTO hf_llm_call (run_id, key, workflow_id, period, input_hash, status, " +
          "estimated_cost_usd, cost_usd) VALUES ($1, 'x', $1, $2, 'hash', 'ok', $3, $3)",
        [`status-budget-${i}`, period, cost],
      );
    }
  });

  const status = (): ReturnType<typeof appStatus> =>
    appStatus(pool, { app: database.appName, applicationVersion: null });

  it("prints spend and ledger at the ledger's scale and calls a settled period healthy", async () => {
    const report = await status();

    expect(report.budget.current).toEqual({
      period,
      budgetUsd: "100.0000",
      spentUsd: LEDGER_USD,
      ledgerUsd: LEDGER_USD,
      driftUsd: "0.000000",
    });
    expect(report.health).toBe("ok");
  });

  it("still reports a period whose counter really has left its ledger", async () => {
    await pool.query("UPDATE hf_budget_period SET spent_usd = spent_usd + 0.000007");

    const report = await status();

    expect(report.budget.current).toMatchObject({
      spentUsd: "0.001700",
      driftUsd: "0.000007",
    });
    expect(report.health).toBe("degraded");
  });
});
