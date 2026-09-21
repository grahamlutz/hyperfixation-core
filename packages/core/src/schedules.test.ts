import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { defineFlow, getClient, resetClient, type Flow } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineApp, type App } from "./define-app.js";
import { defineSchedule, schedulesDue, type AnySchedule } from "./schedules.js";

let database: TestDatabase;
let pool: Pool;
let client: DBOSClient;
let app: App;
let flow: Flow<{ n: number }, void>;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = new Pool({ max: 4, connectionString: database.applicationUrl });
  client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });

  await asRole(database.migratorUrl, async (pg) => {
    await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, '100')");
  });

  // Never dispatched: nothing launches DBOS here. `runs.start` only needs its queue name.
  flow = defineFlow<{ n: number }, void>("nightlyFlow", () => Promise.resolve(), { queue: "llm" });

  app = defineApp({
    name: database.appName,
    applicationVersion: "sha1234567",
    flows: [flow],
    schedules: [defineSchedule({ name: "nightly", flow, every: 60_000, input: () => ({ n: 1 }) })],
  });
  app.attach({ pool, client });
}, 120_000);

afterAll(async () => {
  // The control plane is on the process, not on this file: the pool below is about to be ended,
  // and an attachment left behind is one the next file in this vitest worker would find.
  app?.detach();
  await resetClient();
  await pool?.end();
  await database?.drop();
});

async function runCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>("SELECT count(*) FROM hf_run");
  return Number(rows[0]!.count);
}

describe("schedules.fire()", () => {
  it("starts no run while the app is paused", async () => {
    await pool.query("UPDATE hf_app_state SET paused = true WHERE id = 1");
    const before = await runCount();

    expect(await app.schedules.fire("nightly")).toEqual({ started: false, reason: "paused" });
    expect(await runCount()).toBe(before);
  });

  it("starts the schedule's flow once the app is not paused", async () => {
    await pool.query("UPDATE hf_app_state SET paused = false WHERE id = 1");

    const fired = await app.schedules.fire("nightly");
    expect(fired.started).toBe(true);
    const runId = fired.started ? fired.run.runId : "";

    const { rows } = await pool.query<{ flow: string; status: string; input: { n: number } }>(
      "SELECT flow, status, input FROM hf_run WHERE run_id = $1",
      [runId],
    );
    expect(rows[0]).toMatchObject({ flow: "nightlyFlow", status: "running", input: { n: 1 } });
  });
});

describe("schedules.due()", () => {
  const now = new Date("2026-09-19T12:00:00Z");
  const at = (msAgo: number): Date => new Date(now.getTime() - msAgo);

  it("is due when it has never fired", () => {
    expect(app.schedules.due(now, new Map())).toEqual(["nightly"]);
  });

  it("is not due again until its interval has passed", () => {
    expect(app.schedules.due(now, new Map([["nightly", at(59_999)]]))).toEqual([]);
    expect(app.schedules.due(now, new Map([["nightly", at(60_000)]]))).toEqual(["nightly"]);
  });

  it("ignores a last-fired time for a schedule it does not hold", () => {
    const schedules: readonly AnySchedule[] = [
      defineSchedule({ name: "hourly", flow, every: 3_600_000 }),
    ];
    expect(schedulesDue(schedules, now, new Map([["nightly", now]]))).toEqual(["hourly"]);
  });
});
