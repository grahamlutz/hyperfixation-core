import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { bumpAttempt, controlPlaneTx } from "@hyperfixation/db";
import {
  asRole,
  createTestDatabase,
  killAt,
  killWhenParked,
  spawnWorker,
  testBuildSha,
  type KillAtMode,
  type SpawnedWorker,
  type TestDatabase,
} from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClient, resetClient } from "./client.js";
import { createControlPool, type ControlPool } from "./control-pool.js";
import { runsStart } from "./runs.js";
import { claimRun, concludeRun } from "./run-status.js";
import { UPSERT_FLOW_NAME, UPSERT_STEP_KEY, upsertFlow } from "./test-support/upsert-flow.js";

const UPSERT_MODULE = new URL("./test-support/upsert-flow-fixture.ts", import.meta.url).pathname;

async function createCounterTable(database: TestDatabase): Promise<void> {
  await asRole(database.migratorUrl, async (pg) => {
    await pg.query(
      "CREATE TABLE test_counter (run_id text, step_key text, count int NOT NULL, PRIMARY KEY (run_id, step_key))",
    );
  });
}

async function counterValue(database: TestDatabase, runId: string): Promise<number | undefined> {
  return asRole(database.applicationUrl, async (pg) => {
    const { rows } = await pg.query<{ count: number }>(
      "SELECT count FROM test_counter WHERE run_id = $1 AND step_key = $2",
      [runId, UPSERT_STEP_KEY],
    );
    return rows[0]?.count;
  });
}

async function runStatus(database: TestDatabase, runId: string): Promise<string | undefined> {
  return asRole(database.applicationUrl, async (pg) => {
    const { rows } = await pg.query<{ status: string }>(
      "SELECT status FROM hf_run WHERE run_id = $1",
      [runId],
    );
    return rows[0]?.status;
  });
}

async function waitForStatus(
  database: TestDatabase,
  runId: string,
  status: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await runStatus(database, runId)) === status) return;
    if (Date.now() > deadline) {
      throw new Error(`hf_run ${runId} never reached status ${status} (still ${await runStatus(database, runId)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * One database per scenario, not per file: DBOS ties queue registration to `applicationName`
 * within a system database, so two different appNames sharing one database conflict on the
 * fixed queue names the instant both register them — exactly the "one appName, sequential
 * workers" shape a real redeploy is, and exactly what a shared database across scenarios with
 * distinct appNames is not.
 */
const RECOVERY_MODES: readonly KillAtMode[] = ["after-checkpoint", "before-checkpoint", "in-tx"];

describe.each(RECOVERY_MODES)(
  "chunk 9 smoke — same-version crash recovery (%s)",
  (mode) => {
    let database: TestDatabase;

    beforeAll(async () => {
      database = await createTestDatabase();
      await createCounterTable(database);
    }, 60_000);

    afterAll(async () => {
      await resetClient();
      await database?.drop();
    });

    it(
      "does not re-run a checkpointed step, and the run finishes done",
      async () => {
        const version = testBuildSha();
        const runId = `run-${version}`;
        const appName = database.appName;

        const workerA = spawnWorker({
          module: UPSERT_MODULE,
          appName,
          databaseUrl: database.applicationUrl,
          version,
          control: { killAt: killAt(UPSERT_STEP_KEY, mode) },
        });

        try {
          await workerA.ready();

          const control = createControlPool({ connectionString: database.applicationUrl });
          const client = await getClient({ appName, databaseUrl: database.applicationUrl });
          try {
            await runsStart(control.pool, client, upsertFlow, {}, { runId });
          } finally {
            await control.end();
          }

          await killWhenParked(workerA, killAt(UPSERT_STEP_KEY, mode), 30_000);
          // 'after-checkpoint' is the only mode where the write landed before the kill; the
          // other two are killed before anything could have committed.
          const expectedBeforeRelaunch = mode === "after-checkpoint" ? 1 : undefined;
          expect(await counterValue(database, runId)).toBe(expectedBeforeRelaunch);
        } finally {
          await workerA.kill().catch(() => undefined);
        }

        const workerB = spawnWorker({
          module: UPSERT_MODULE,
          appName,
          databaseUrl: database.applicationUrl,
          version,
        });
        try {
          await workerB.ready();
          await waitForStatus(database, runId, "done", 30_000);
          expect(await counterValue(database, runId)).toBe(1);
          await workerB.shutdown();
        } finally {
          await workerB.kill().catch(() => undefined);
        }
      },
      120_000,
    );
  },
);

describe("chunk 9 smoke — a superseded attempt's status write is refused", () => {
  let database: TestDatabase;
  let control: ControlPool;

  beforeAll(async () => {
    database = await createTestDatabase();
    control = createControlPool({ connectionString: database.applicationUrl });
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query(
        `INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id)
         VALUES ('superseded-run', $1, '{}', 'running', 1, 'superseded-run')`,
        [UPSERT_FLOW_NAME],
      );
    });
  }, 60_000);

  afterAll(async () => {
    await control?.end();
    await database?.drop();
  });

  it("lets claimRun succeed for the live attempt, then refuses the old one after a bump", async () => {
    await expect(
      claimRun(control.pool, "superseded-run", "superseded-run", "sha0000000"),
    ).resolves.toBe(true);

    const bumped = await controlPlaneTx(control.pool, { operation: "test-bump" }, (pg) =>
      bumpAttempt(pg, "superseded-run"),
    );
    expect(bumped.workflowId).toBe("superseded-run:2");

    // The attempt-1 wrapper concluding after the bump must not clobber the run the bump moved on.
    await expect(
      concludeRun(control.pool, "superseded-run", "superseded-run", "done", null),
    ).resolves.toBe(false);

    expect(await runStatus(database, "superseded-run")).toBe("running");
  });
});

describe("chunk 9 smoke — a paused app suspends the run at its next step", () => {
  let database: TestDatabase;
  let worker: SpawnedWorker;
  let control: ControlPool;
  let client: DBOSClient;

  beforeAll(async () => {
    database = await createTestDatabase();
    await createCounterTable(database);
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, true, 0)");
    });

    worker = spawnWorker({
      module: UPSERT_MODULE,
      appName: database.appName,
      databaseUrl: database.applicationUrl,
    });
    await worker.ready();

    control = createControlPool({ connectionString: database.applicationUrl });
    client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
  }, 60_000);

  afterAll(async () => {
    await resetClient();
    await control?.end();
    await worker?.kill();
    await database?.drop();
  });

  it(
    "throws Suspend at the step gate and leaves the run paused, with no upsert applied",
    async () => {
      const runId = "paused-run";
      await runsStart(control.pool, client, upsertFlow, {}, { runId });

      await waitForStatus(database, runId, "paused", 30_000);
      expect(await counterValue(database, runId)).toBeUndefined();
    },
    60_000,
  );
});
