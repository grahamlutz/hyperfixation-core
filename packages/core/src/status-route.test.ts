import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { getClient, resetClient } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineApp, type App } from "./define-app.js";
import { hashStatusToken } from "./status-token.js";
import { STATUS_TOKEN_ACTOR } from "./status-route.js";
import type { StatusReport } from "./status.js";

const READ_TOKEN = "read-token-value";
const WRITE_TOKEN = "write-token-value";
const VERSION = "sha1234567";

describe("the status endpoint", () => {
  let database: TestDatabase;
  let pool: Pool;
  let client: DBOSClient;
  let app: App;

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = new Pool({ max: 4, connectionString: database.applicationUrl });
    client = await getClient({
      appName: database.appName,
      databaseUrl: database.applicationUrl,
    });
    app = defineApp({ name: database.appName, applicationVersion: VERSION });
    app.attach({ pool, client });
  }, 120_000);

  afterAll(async () => {
    // The control plane is on the process, not on this file: the pool below is about to be
    // ended, and an attachment left behind is one the next file in this worker would find.
    app?.detach();
    await resetClient();
    await pool?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query("DELETE FROM hf_audit");
      await pg.query("DELETE FROM hf_app_state");
      await pg.query(
        "INSERT INTO hf_app_state (id, paused, budget_usd, read_token_hash, write_token_hash) " +
          "VALUES (1, false, '100', $1, $2)",
        [hashStatusToken(READ_TOKEN), hashStatusToken(WRITE_TOKEN)],
      );
    });
  });

  const call = (path: string, method: string, token?: string): Promise<Response> =>
    app.statusHandler(
      new Request(`https://app.test${path}`, {
        method,
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      }),
    );

  it("answers a read token with the app's state", async () => {
    const response = await call("/api/status", "GET", READ_TOKEN);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const report = (await response.json()) as StatusReport;
    expect(report).toMatchObject({
      health: "ok",
      app: database.appName,
      applicationVersion: VERSION,
      paused: false,
      pausedBy: null,
      anomalies: 0,
      runs: { running: 0, waiting: 0, paused: 0, done: 0, failed: 0 },
      // Nothing has built an LLM registry, so nothing has reported what it serves.
      llm: { mode: "unknown" },
    });
    expect(report.coreVersion).toMatch(/^\d+\.\d+\.\d+/);
    // No gate has run, so no period row exists yet; the endpoint reports that rather than
    // inventing a zeroed one.
    expect(report.budget).toEqual({ current: null, previous: null });
  });

  it("reports the mode the worker reported, in the web process that never built a registry", async () => {
    for (const [reported, expected] of [
      ["fixtures", "fixtures"],
      ["live", "live"],
      // A mode written by a newer core than the one answering reads as no answer at all.
      ["something-else", "unknown"],
    ]) {
      await pool.query("UPDATE hf_app_state SET llm_mode = $1 WHERE id = 1", [reported]);
      const report = (await (await call("/api/status", "GET", READ_TOKEN)).json()) as StatusReport;

      expect(report.llm.mode, reported).toBe(expected);
    }
  });

  it("refuses a read with no token, a wrong token, and a token in the wrong place", async () => {
    for (const response of [
      await call("/api/status", "GET"),
      await call("/api/status", "GET", `${READ_TOKEN}x`),
      await call("/api/status", "GET", WRITE_TOKEN.slice(0, 4)),
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  it("refuses everything once the hashes are unset, rather than opening up", async () => {
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query("UPDATE hf_app_state SET read_token_hash = NULL, write_token_hash = NULL");
    });

    expect((await call("/api/status", "GET", READ_TOKEN)).status).toBe(401);
    expect((await call("/api/status/pause", "POST", WRITE_TOKEN)).status).toBe(401);
  });

  it("will not pause or resume on the read token", async () => {
    expect((await call("/api/status/pause", "POST", READ_TOKEN)).status).toBe(401);
    expect((await call("/api/status/resume", "POST", READ_TOKEN)).status).toBe(401);
    expect(await paused()).toBe(false);
  });

  it("pauses and resumes on the write token", async () => {
    const paused_ = await call("/api/status/pause", "POST", WRITE_TOKEN);
    expect(paused_.status).toBe(200);
    expect(await paused_.json()).toMatchObject({ paused: true });
    expect(await paused()).toBe(true);
    expect(await pausedBy()).toBe(STATUS_TOKEN_ACTOR);

    const report = (await (await call("/api/status", "GET", WRITE_TOKEN)).json()) as StatusReport;
    // The write token reads too: it is strictly the more privileged of the two.
    expect(report.paused).toBe(true);

    const resumed = await call("/api/status/resume", "POST", WRITE_TOKEN);
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ paused: false });
    expect(await paused()).toBe(false);
    expect(await pausedBy()).toBeNull();

    const audit = await pool.query<{ action: string; actor_id: string | null }>(
      "SELECT action, actor_id FROM hf_audit ORDER BY id",
    );
    expect(audit.rows).toEqual([
      { action: "app.paused", actor_id: STATUS_TOKEN_ACTOR },
      { action: "app.resumed", actor_id: STATUS_TOKEN_ACTOR },
    ]);
  });

  it("answers the wrong method and an unknown path without touching the app", async () => {
    const wrongMethod = await call("/api/status/pause", "GET", WRITE_TOKEN);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");

    expect((await call("/api/status", "POST", WRITE_TOKEN)).status).toBe(405);
    expect((await call("/api/status/other", "GET", WRITE_TOKEN)).status).toBe(404);
    expect(await paused()).toBe(false);
  });

  async function paused(): Promise<boolean> {
    const { rows } = await pool.query<{ paused: boolean }>(
      "SELECT paused FROM hf_app_state WHERE id = 1",
    );
    return rows[0]!.paused;
  }

  async function pausedBy(): Promise<string | null> {
    const { rows } = await pool.query<{ paused_by: string | null }>(
      "SELECT paused_by FROM hf_app_state WHERE id = 1",
    );
    return rows[0]!.paused_by;
  }
});
