import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../migrate.js";
import { asRole, createTestDatabase, type TestDatabase } from "../test-support/database.js";
import { CONTROL_POOL_SIZE, createControlPool, type ControlPool } from "./control-pool.js";

let database: TestDatabase;
let control: ControlPool;

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.migratorUrl, { appName: database.appName });
  await asRole(database.applicationUrl, async (client) => {
    await client.query(
      `INSERT INTO hf_run (run_id, flow, status, attempt, current_workflow_id)
       VALUES ('control-pool-run', 'demo', 'running', 1, 'control-pool-run')`,
    );
  });
  control = createControlPool({ connectionString: database.applicationUrl });
}, 60_000);

afterAll(async () => {
  await control?.end();
  await database?.drop();
});

describe("createControlPool", () => {
  it("sizes the pool at 2 connections", () => {
    expect(CONTROL_POOL_SIZE).toBe(2);
    expect(control.pool.options.max).toBe(2);
  });

  it("has no fence: a write commits with no ctx.tx equivalent", async () => {
    await control.db.execute(
      sql`UPDATE hf_run SET version = 'control-pool-probe' WHERE run_id = 'control-pool-run'`,
    );

    const { rows } = await control.pool.query<{ version: string | null }>(
      "SELECT version FROM hf_run WHERE run_id = 'control-pool-run'",
    );
    expect(rows[0]?.version).toBe("control-pool-probe");
  });

  it("reads through the pool too", async () => {
    const { rows } = await control.pool.query<{ one: number }>("SELECT 1 AS one");
    expect(rows[0]?.one).toBe(1);
  });
});
