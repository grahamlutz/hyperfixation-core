import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StatusReport } from "@hyperfixation/core";
import { BootCheckFailure } from "@hyperfixation/db";
import { ADMIN_URL, asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { http, HttpResponse } from "msw";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "./cli.js";
import { openDatabaseUrl, type Database } from "./database.js";
import {
  checkAppRolePrivileges,
  doctor,
  doctorLines,
  workerLockSql,
  type DoctorOptions,
} from "./doctor.js";
import { openAppState, type AppState } from "./state.js";
import { createOpenApiHarness, type StubRoute } from "./test-support/openapi.js";

const APP = "demo-app";
const BASE_DOMAIN = "hf.test";
const STATUS_URL = `https://${APP}.${BASE_DOMAIN}/api/status`;
/** A second app on the same box, for the checks that are the box's rather than one app's. */
const OTHER_APP = "other-app";
const OTHER_STATUS_URL = `https://${OTHER_APP}.${BASE_DOMAIN}/api/status`;
const GITHUB = "https://api.github.com";
const REPO = `grahamlutz/${APP}`;

const MAIN_SHA = "1111111111111111111111111111111111111111";
const DEPLOYED_SHA = "2222222222222222222222222222222222222222";
const NOW = new Date("2026-09-19T12:00:00.000Z");

/** Every secret a state file holds, so one assertion can prove none of them is printed. */
const SECRETS = {
  readToken: "read-token-sekrit",
  writeToken: "write-token-sekrit",
  migratorPassword: "migrator-sekrit",
  applicationPassword: "application-sekrit",
  readonlyPassword: "readonly-sekrit",
  langfuseSecretKey: "langfuse-sekrit",
  githubToken: "github-token-sekrit",
};

const ROUTES: StubRoute[] = [
  {
    spec: "github",
    method: "get",
    url: `${GITHUB}/repos/{owner}/{repo}/git/ref/heads/main`,
    json: { ref: "refs/heads/main", object: { sha: MAIN_SHA, type: "commit" } },
  },
  { spec: "github", method: "get", url: `${GITHUB}/repos/{owner}/{repo}/pulls`, json: [] },
  {
    spec: "github",
    method: "get",
    url: `${GITHUB}/repos/{owner}/{repo}/commits/{ref}/status`,
    json: { state: "success", total_count: 1 },
  },
];

const harness = createOpenApiHarness(ROUTES);
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-doctor-"));
  tempDirs.push(dir);
  return dir;
}

function stateOf(overrides: Partial<AppState> = {}): Partial<AppState> {
  return {
    repo: REPO,
    statusTokens: { read: SECRETS.readToken, write: SECRETS.writeToken },
    database: {
      migratorPassword: SECRETS.migratorPassword,
      applicationPassword: SECRETS.applicationPassword,
      readonlyPassword: SECRETS.readonlyPassword,
    },
    langfuse: { publicKey: "pk-lf", secretKey: SECRETS.langfuseSecretKey },
    lastRestoreCheckAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
    lastDeployedSha: MAIN_SHA,
    ...overrides,
  };
}

/** A state directory holding one app, written the way the cloud path writes it. */
async function stateDirWith(state: Partial<AppState> = stateOf()): Promise<string> {
  const dir = await tempDir();
  const store = await openAppState(APP, { dir });
  await store.patch(state);
  return dir;
}

function statusReport(overrides: Partial<StatusReport> = {}): StatusReport {
  return {
    health: "ok",
    app: "demo_app",
    applicationVersion: MAIN_SHA,
    coreVersion: "0.1.0",
    paused: false,
    pausedBy: null,
    llm: { mode: "live" },
    runs: { running: 1, waiting: 0, paused: 0, done: 12, failed: 0 },
    queues: [],
    approvals: {},
    llmCalls: {},
    actions: {},
    budget: {
      current: {
        period: "2026-09",
        budgetUsd: "50.000000",
        spentUsd: "3.250000",
        ledgerUsd: "3.250000",
        driftUsd: "0.000000",
      },
      previous: null,
    },
    anomalies: 0,
    at: NOW.toISOString(),
    ...overrides,
  };
}

function otherStatusHandler(json: StatusReport): ReturnType<typeof http.get> {
  return http.get(OTHER_STATUS_URL, () => HttpResponse.json(json));
}

/** A record, not a `StatusReport`: the shape an older core answers with is the point of some. */
function statusHandler(
  json: StatusReport | Record<string, unknown>,
  status = 200,
): ReturnType<typeof http.get> {
  return http.get(STATUS_URL, () => HttpResponse.json(json, { status }));
}

const ROLE = "hf_demo_app";
const DATABASE = "hf_demo_app";

interface ClusterStub {
  maxConnections?: number;
  /** Backends per role, as `pg_stat_activity` grouped by `usename` hands them back. */
  backends?: Record<string, number>;
  /** Per database: how many advisory locks are held, and how many carry the worker's key. */
  locks?: Record<string, { held: number; matching?: number }>;
  /** A query whose SQL matches refuses, the way a tunnel that died under it does. */
  fails?: RegExp;
}

/** The cluster as `hf doctor` queries it: canned counts in the row shape `Database` returns. */
function cluster(stub: ClusterStub = {}): {
  open: () => Promise<Database>;
  counts: { opens: number; closes: number };
} {
  const counts = { opens: 0, closes: 0 };
  const database: Database = {
    kind: "tunnel",
    adminUrl: () => undefined,
    query: (sql, queryOptions) => {
      if (stub.fails?.test(sql) === true) return Promise.reject(new Error("connection terminated"));
      if (sql.startsWith("SHOW max_connections")) {
        return Promise.resolve({ rows: [[String(stub.maxConnections ?? 100)]] });
      }
      if (sql.includes("pg_stat_activity")) {
        return Promise.resolve({
          rows: Object.entries(stub.backends ?? { [ROLE]: 7 }).map(([role, count]) => [
            role,
            String(count),
          ]),
        });
      }
      const lock = stub.locks?.[queryOptions?.database ?? ""] ?? { held: 1 };
      return Promise.resolve({ rows: [[String(lock.held), String(lock.matching ?? lock.held)]] });
    },
    close: () => {
      counts.closes += 1;
      return Promise.resolve();
    },
  };
  return {
    open: () => {
      counts.opens += 1;
      return Promise.resolve(database);
    },
    counts,
  };
}

function options(dir: string, overrides: Partial<DoctorOptions> = {}): DoctorOptions {
  return {
    stateDir: dir,
    env: {},
    config: { HF_BASE_DOMAIN: BASE_DOMAIN, HF_GITHUB_TOKEN: SECRETS.githubToken },
    now: () => NOW,
    // E006 needs a cluster; the check itself is exercised against one further down.
    privileges: async () => undefined,
    database: cluster().open,
    ...overrides,
  };
}

function findingOf(lines: readonly string[], check: string): string {
  const line = lines.find((candidate) => candidate.includes(` ${check}:`));
  expect(line, `no ${check} line in:\n${lines.join("\n")}`).toBeDefined();
  return line!;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe("hf doctor", () => {
  beforeAll(() => harness.server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => {
    harness.server.resetHandlers();
    const violations = harness.takeViolations();
    harness.reset();
    expect(violations).toEqual([]);
  });
  afterAll(() => harness.server.close());

  it("says OK on every check and stays green when nothing is wrong", async () => {
    const dir = await stateDirWith();
    harness.server.use(statusHandler(statusReport()));

    const result = await doctor(options(dir, { name: APP }));
    const lines = doctorLines(result);

    expect(result.ok).toBe(true);
    expect(lines[0]).toBe(APP);
    expect(lines.slice(1).every((line) => line.startsWith("  OK  "))).toBe(true);
    expect(findingOf(lines, "version")).toContain("is main");
    expect(findingOf(lines, "runs")).toContain("1 run(s) running");
    expect(findingOf(lines, "core-bump")).toContain("no open core-bump pull request");
  });

  it("says OK on an app whose state holds no Langfuse keys at all", async () => {
    const dir = await stateDirWith(stateOf({ langfuse: undefined }));
    harness.server.use(statusHandler(statusReport()));

    const result = await doctor(options(dir, { name: APP }));

    expect(result.ok).toBe(true);
    expect(doctorLines(result).slice(1).every((line) => line.startsWith("  OK  "))).toBe(true);
  });

  it("sends the read token from state as the bearer, and nothing else", async () => {
    const dir = await stateDirWith();
    const authorization: (string | null)[] = [];
    harness.server.use(
      http.get(STATUS_URL, ({ request }) => {
        authorization.push(request.headers.get("authorization"));
        return HttpResponse.json(statusReport());
      }),
    );

    await doctor(options(dir, { name: APP }));

    expect(authorization).toEqual([`Bearer ${SECRETS.readToken}`]);
  });

  it("warns when the deployed applicationVersion is not main's sha", async () => {
    const dir = await stateDirWith();
    harness.server.use(statusHandler(statusReport({ applicationVersion: DEPLOYED_SHA })));

    const result = await doctor(options(dir, { name: APP }));

    expect(result.ok).toBe(false);
    expect(findingOf(doctorLines(result), "version")).toBe(
      `  WARN version: applicationVersion 2222222 is not main 1111111 — run hf deploy ${APP}`,
    );
  });

  it("warns that an app is serving fixture drafts, and only about that mode", async () => {
    const dir = await stateDirWith();
    harness.server.use(statusHandler(statusReport({ llm: { mode: "fixtures" } })));

    const result = await doctor(options(dir, { name: APP }));

    expect(result.ok).toBe(false);
    expect(findingOf(doctorLines(result), "llm")).toBe(
      "  WARN llm: app is serving fixture drafts — no provider key set",
    );
  });

  it("says nothing about a live app, or one whose worker has not reported yet", async () => {
    for (const mode of ["live", "unknown"] as const) {
      const dir = await stateDirWith();
      harness.server.use(statusHandler(statusReport({ llm: { mode } })));

      const result = await doctor(options(dir, { name: APP }));

      expect(result.ok, mode).toBe(true);
      expect(doctorLines(result).some((line) => line.includes(" llm:")), mode).toBe(false);
      harness.server.resetHandlers();
    }
  });

  it("reads a 0.1.0 app's status, which has no llm key at all", async () => {
    const dir = await stateDirWith();
    const old: Record<string, unknown> = { ...statusReport() };
    delete old.llm;
    harness.server.use(statusHandler(old));

    const result = await doctor(options(dir, { name: APP }));
    const lines = doctorLines(result);

    expect(result.ok).toBe(true);
    expect(findingOf(lines, "status")).toBe(
      "  OK   status: health ok, 0 anomaly/anomalies, core 0.1.0",
    );
    expect(lines.some((line) => line.includes(" llm:"))).toBe(false);
    expect(findingOf(lines, "budget")).toContain("2026-09 spent $3.250000 of $50.000000");
  });

  it("says unknown rather than throwing when a status field is newer than the core", async () => {
    const dir = await stateDirWith();
    // Everything `hf doctor` reads, absent at once: an app on a core old enough to answer with
    // none of it still has its E006, restore-check and core-bump lines.
    harness.server.use(statusHandler({ app: "demo_app", at: NOW.toISOString() }));

    const result = await doctor(options(dir, { name: APP }));
    const lines = doctorLines(result);

    expect(findingOf(lines, "status")).toBe(
      "  OK   status: health unknown, unknown anomaly/anomalies, core unknown",
    );
    expect(lines.some((line) => line.includes(" runs:"))).toBe(false);
    expect(lines.some((line) => line.includes(" budget:"))).toBe(false);
    expect(lines.some((line) => line.includes(" llm:"))).toBe(false);
    expect(findingOf(lines, "E006")).toContain("OK");
    expect(findingOf(lines, "core-bump")).toContain("no open core-bump pull request");
    expect(result.ok).toBe(true);
  });

  it("fails E006 on one line when a privilege is false", async () => {
    const dir = await stateDirWith();
    harness.server.use(statusHandler(statusReport()));

    const result = await doctor(
      options(dir, {
        name: APP,
        privileges: () =>
          Promise.reject(
            new BootCheckFailure("E006", "the application role lacks its dbos grants", [
              "has_schema_privilege('dbos', 'USAGE') is false",
              "has_table_privilege('dbos.workflow_status', 'INSERT') is false",
            ]),
          ),
      }),
    );

    const line = findingOf(doctorLines(result), "E006");
    expect(result.ok).toBe(false);
    expect(line).toContain("FAIL");
    expect(line).toContain("has_schema_privilege('dbos', 'USAGE') is false");
    expect(line).toContain("has_table_privilege('dbos.workflow_status', 'INSERT') is false");
    expect(line).not.toContain("\n");
  });

  it("counts the app's backends against its role limit and the box's against max_connections", async () => {
    const dir = await stateDirWith();
    harness.server.use(statusHandler(statusReport()));
    const box = cluster();

    const result = await doctor(options(dir, { name: APP, database: box.open }));

    expect(result.ok).toBe(true);
    expect(findingOf(doctorLines(result), "connections")).toBe(
      `  OK   connections: ${ROLE} 7/25, box 7/100 on hf_ roles`,
    );
    // One cluster connection for the run, closed once however the findings went.
    expect(box.counts).toEqual({ opens: 1, closes: 1 });
  });

  it("warns when the box's hf_ roles hold more than 80% of max_connections", async () => {
    const dir = await stateDirWith();
    harness.server.use(statusHandler(statusReport()));

    const result = await doctor(
      options(dir, {
        name: APP,
        database: cluster({
          maxConnections: 100,
          backends: { [ROLE]: 20, [`${ROLE}_migrator`]: 5, hf_other_app: 60 },
        }).open,
      }),
    );

    expect(result.ok).toBe(false);
    expect(findingOf(doctorLines(result), "connections")).toBe(
      `  WARN connections: ${ROLE} 20/25, box 85/100 on hf_ roles — over 80% of max_connections`,
    );
  });

  it("fails when no worker holds the app's advisory lock", async () => {
    const dir = await stateDirWith();
    harness.server.use(statusHandler(statusReport()));

    const result = await doctor(
      options(dir, { name: APP, database: cluster({ locks: { [DATABASE]: { held: 0 } } }).open }),
    );

    expect(result.ok).toBe(false);
    expect(findingOf(doctorLines(result), "lock")).toBe(
      `  FAIL lock: no advisory lock in ${DATABASE}: no worker holds hf-worker:demo_app`,
    );
  });

  it("fails on two locks under the worker's key, and on one lock that is not it", async () => {
    const dir = await stateDirWith();
    harness.server.use(statusHandler(statusReport()));

    const two = await doctor(
      options(dir, { name: APP, database: cluster({ locks: { [DATABASE]: { held: 2 } } }).open }),
    );
    expect(two.ok).toBe(false);
    expect(findingOf(doctorLines(two), "lock")).toContain(
      `FAIL lock: 2 advisory locks on hf-worker:demo_app in ${DATABASE}`,
    );

    harness.server.use(statusHandler(statusReport()));
    const other = await doctor(
      options(dir, {
        name: APP,
        database: cluster({ locks: { [DATABASE]: { held: 1, matching: 0 } } }).open,
      }),
    );
    expect(other.ok).toBe(false);
    expect(findingOf(doctorLines(other), "lock")).toContain(
      "carries hashtext('hf-worker:demo_app'): 1 held, none the worker's",
    );
  });

  /**
   * `fetch.get` holds `pg_advisory_xact_lock(hashtext('hf-fetch:' || domain))` across a request,
   * so an app mid-fetch has a second advisory lock that is nothing to do with the worker. Counting
   * every lock made that a `FAIL`, and `hf doctor` gates deploys.
   */
  it("passes with the worker's lock held alongside an in-flight fetch's lock", async () => {
    const dir = await stateDirWith();
    harness.server.use(statusHandler(statusReport()));

    const result = await doctor(
      options(dir, {
        name: APP,
        database: cluster({ locks: { [DATABASE]: { held: 2, matching: 1 } } }).open,
      }),
    );

    expect(findingOf(doctorLines(result), "lock")).toBe(
      `  OK   lock: one worker holds hf-worker:demo_app in ${DATABASE}`,
    );
    expect(result.ok).toBe(true);
  });

  it("reports one app's lock without the other app's deciding it", async () => {
    const dir = await tempDir();
    for (const name of [APP, OTHER_APP]) {
      await (await openAppState(name, { dir })).patch(stateOf({ repo: `grahamlutz/${name}` }));
    }
    harness.server.use(statusHandler(statusReport()), otherStatusHandler(statusReport()));

    const result = await doctor(
      options(dir, {
        database: cluster({ locks: { [DATABASE]: { held: 1 }, hf_other_app: { held: 0 } } }).open,
      }),
    );
    const locks = doctorLines(result).filter((line) => line.includes(" lock:"));

    expect(result.ok).toBe(false);
    expect(locks).toEqual([
      `  OK   lock: one worker holds hf-worker:demo_app in ${DATABASE}`,
      "  FAIL lock: no advisory lock in hf_other_app: no worker holds hf-worker:other_app",
    ]);
  });

  it("fails, rather than crashes, when a cluster query refuses", async () => {
    const dir = await stateDirWith();
    harness.server.use(statusHandler(statusReport()));

    const locks = await doctor(
      options(dir, { name: APP, database: cluster({ fails: /pg_locks/ }).open }),
    );
    expect(locks.ok).toBe(false);
    expect(findingOf(doctorLines(locks), "lock")).toBe("  FAIL lock: connection terminated");
    expect(findingOf(doctorLines(locks), "connections")).toContain("OK");

    harness.server.use(statusHandler(statusReport()));
    const backends = await doctor(
      options(dir, { name: APP, database: cluster({ fails: /pg_stat_activity/ }).open }),
    );
    expect(backends.ok).toBe(false);
    expect(findingOf(doctorLines(backends), "connections")).toBe(
      "  FAIL connections: connection terminated",
    );
  });

  it("warns when the last restore check is older than a week, and when there is none", async () => {
    const stale = await stateDirWith(
      stateOf({ lastRestoreCheckAt: new Date(NOW.getTime() - 30 * 86_400_000).toISOString() }),
    );
    harness.server.use(statusHandler(statusReport()));

    const result = await doctor(options(stale, { name: APP }));
    expect(result.ok).toBe(false);
    expect(findingOf(doctorLines(result), "restore-check")).toContain("WARN");
    expect(findingOf(doctorLines(result), "restore-check")).toContain("30.0 day(s) ago");

    const never = await stateDirWith(stateOf({ lastRestoreCheckAt: undefined }));
    harness.server.use(statusHandler(statusReport()));

    const second = await doctor(options(never, { name: APP }));
    expect(second.ok).toBe(false);
    expect(findingOf(doctorLines(second), "restore-check")).toContain("never run");
  });

  it("warns on degraded health, and on a period that is over budget or drifting", async () => {
    const dir = await stateDirWith();
    harness.server.use(
      statusHandler(
        statusReport({
          health: "degraded",
          anomalies: 2,
          budget: {
            current: {
              period: "2026-09",
              budgetUsd: "50.000000",
              spentUsd: "51.500000",
              ledgerUsd: "50.000000",
              driftUsd: "1.500000",
            },
            previous: null,
          },
        }),
      ),
    );

    const result = await doctor(options(dir, { name: APP }));
    const lines = doctorLines(result);

    expect(result.ok).toBe(false);
    expect(findingOf(lines, "status")).toBe("  WARN status: health degraded, 2 anomaly/anomalies, core 0.1.0");
    expect(findingOf(lines, "budget")).toContain("over budget");
    expect(findingOf(lines, "budget")).toContain("drift $1.500000");
  });

  it("warns on an open core-bump pull request whose checks failed", async () => {
    const dir = await stateDirWith();
    harness.server.use(
      statusHandler(statusReport()),
      harness.handler({
        spec: "github",
        method: "get",
        url: `${GITHUB}/repos/{owner}/{repo}/pulls`,
        json: [
          {
            number: 7,
            title: "Bump @hyperfixation/core",
            html_url: `https://github.com/${REPO}/pull/7`,
            head: { ref: "core-bump/0.2.0", sha: DEPLOYED_SHA },
          },
          {
            number: 8,
            title: "Something the operator opened",
            html_url: `https://github.com/${REPO}/pull/8`,
            head: { ref: "add-a-flow", sha: DEPLOYED_SHA },
          },
        ],
      }),
      harness.handler({
        spec: "github",
        method: "get",
        url: `${GITHUB}/repos/{owner}/{repo}/commits/{ref}/status`,
        json: { state: "failure", total_count: 3 },
      }),
    );

    const result = await doctor(options(dir, { name: APP }));
    const bumps = doctorLines(result).filter((line) => line.includes(" core-bump:"));

    expect(result.ok).toBe(false);
    expect(bumps).toEqual([
      `  WARN core-bump: #7 core-bump/0.2.0: checks failure — https://github.com/${REPO}/pull/7`,
    ]);
  });

  it("fails, rather than crashes, on a missing read token", async () => {
    const dir = await stateDirWith(stateOf({ statusTokens: {} }));

    const result = await doctor(options(dir, { name: APP }));

    expect(result.ok).toBe(false);
    expect(findingOf(doctorLines(result), "status")).toContain("no read status token in state");
    // The rest of the app is still reported: an unprovisioned token is not a reason to stop.
    expect(findingOf(doctorLines(result), "E006")).toContain("OK");
  });

  it("fails, rather than crashes, when the app cannot be reached", async () => {
    const dir = await stateDirWith();
    harness.server.use(http.get(STATUS_URL, () => HttpResponse.error()));

    const result = await doctor(options(dir, { name: APP }));

    expect(result.ok).toBe(false);
    expect(findingOf(doctorLines(result), "status")).toContain(`FAIL status: GET ${STATUS_URL}`);
  });

  it("fails on an app the state cache has never heard of", async () => {
    const dir = await tempDir();

    const result = await doctor(options(dir, { name: "no-such-app" }));

    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(findingOf(doctorLines(result), "state")).toContain("hf new has not provisioned");
  });

  it("prints no secret, on the clear path or on a refusal", async () => {
    const dir = await stateDirWith();
    harness.server.use(statusHandler(statusReport()));
    const clear = doctorLines(await doctor(options(dir, { name: APP }))).join("\n");

    harness.server.use(statusHandler({ error: "unauthorized" }, 401));
    const refused = doctorLines(await doctor(options(dir, { name: APP }))).join("\n");

    expect(refused).toContain("HTTP 401");
    for (const secret of Object.values(SECRETS)) {
      expect(clear).not.toContain(secret);
      expect(refused).not.toContain(secret);
    }
  });

  it("exits 0 through the CLI when the state cache holds no app", async () => {
    const home = await tempDir();
    const saved = { ...process.env };
    Object.assign(process.env, {
      XDG_CONFIG_HOME: home,
      HF_BASE_DOMAIN: BASE_DOMAIN,
      HF_GITHUB_TOKEN: SECRETS.githubToken,
      HF_SSH_HOST: "box.test",
    });

    const lines: string[] = [];
    try {
      const code = await main(["doctor"], {
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
      });
      expect(code).toBe(0);
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }

    expect(lines.join("\n")).toContain("no apps in the state cache");
  });
});

describe("workerLockSql", () => {
  let db: TestDatabase;
  let holder: Client;

  /** `WORKER_LOCK_STATEMENT` in `@hyperfixation/workflows`, which the CLI does not depend on. */
  const ACQUIRE = "SELECT pg_try_advisory_lock(hashtext('hf-worker:' || $1::text))";

  beforeAll(async () => {
    db = await createTestDatabase();
    holder = new Client({ connectionString: db.applicationUrl });
    await holder.connect();
  }, 60_000);

  afterAll(async () => {
    await holder.end();
    await db.drop();
  }, 30_000);

  it("counts the worker's own lock, and does not count another app's key as it", async () => {
    const cluster = openDatabaseUrl(ADMIN_URL);
    const count = async (appName: string): Promise<string[] | undefined> =>
      (await cluster.query(workerLockSql(appName), { database: db.databaseName })).rows[0];

    try {
      expect(await count(db.appName)).toEqual(["0", "0"]);

      await holder.query(ACQUIRE, [db.appName]);

      // The split across classid/objid is the whole risk here: a wrong one reads as a lock held
      // under someone else's key, which is a FAIL line on a healthy app.
      expect(await count(db.appName)).toEqual(["1", "1"]);
      expect(await count(`${db.appName}_elsewhere`)).toEqual(["1", "0"]);
    } finally {
      await cluster.close();
    }
  }, 30_000);
});

describe("checkAppRolePrivileges", () => {
  const role = `hf_doctor_${randomBytes(4).toString("hex")}`;

  beforeAll(async () => {
    await asRole(ADMIN_URL, async (admin) => {
      await admin.query(`CREATE ROLE "${role}" NOLOGIN`);
    });
  }, 30_000);

  afterAll(async () => {
    await asRole(ADMIN_URL, async (admin) => {
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    });
  }, 30_000);

  it("reads E006 as the app role, and reports both privileges when dbos is not there", async () => {
    const failure = (await checkAppRolePrivileges(ADMIN_URL, role).catch(
      (error: unknown) => error,
    )) as BootCheckFailure;

    expect(failure).toBeInstanceOf(BootCheckFailure);
    expect(failure.code).toBe("E006");
    expect(failure.details).toEqual([
      "has_schema_privilege('dbos', 'USAGE') is false",
      "has_table_privilege('dbos.workflow_status', 'INSERT') is false",
    ]);
  }, 30_000);

  it("fails on a role the cluster does not have", async () => {
    await expect(checkAppRolePrivileges(ADMIN_URL, `${role}_absent`)).rejects.toThrow(/does not exist/);
  }, 30_000);
});
