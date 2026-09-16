import { randomUUID } from "node:crypto";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { bumpAttempt, controlPlaneTx } from "@hyperfixation/db";
import { migrate } from "@hyperfixation/db/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClient } from "./client.js";
import { createControlPool, type ControlPool } from "./control-pool.js";
import { LAUNCHED_MARKER } from "./start-worker.js";
import { asRole, createTestDatabase, type TestDatabase } from "./test-support/database.js";
import { FIXTURE_READY } from "./test-support/fixture-protocol.js";
import { spawnFixture, type Fixture } from "./test-support/spawn-fixture.js";

const RUN_ID = "case10-run";
const QUEUE = "resolve";

/**
 * redeploy.test.ts case 10's launch half. Chunk 3 proved the grants; this proves a worker
 * actually launches on them, in a real process, and that the application role can enqueue
 * into `dbos.workflow_status` from a transaction of its own while it is up.
 *
 * The enqueue stands in for `runs.start`, which chunk 9 builds: the bump path and the
 * control-plane commit helper are already the parts of it that touch the database.
 */
describe("redeploy case 10 — the launch half", () => {
  let database: TestDatabase;
  let worker: Fixture;
  let control: ControlPool;
  let client: DBOSClient;

  beforeAll(async () => {
    database = await createTestDatabase();
    await migrate(database.migratorUrl, { appName: database.appName });
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query(
        `INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id)
         VALUES ($1, 'demoFlow', $2, 'running', 1, $1)`,
        [RUN_ID, JSON.stringify({ run: RUN_ID })],
      );
    });

    worker = spawnFixture({
      appName: database.appName,
      databaseUrl: database.applicationUrl,
      buildSha: `test-${randomUUID()}`,
    });
    await worker.waitFor(FIXTURE_READY);
  }, 180_000);

  afterAll(async () => {
    await client?.destroy();
    await control?.end();
    await worker?.kill();
    await database?.drop();
  });

  it("launches DBOS in a real worker process", () => {
    expect(worker.output()).toContain(LAUNCHED_MARKER);
    expect(worker.child.exitCode).toBeNull();
  });

  it("registers the three queues at their fixed concurrencies", async () => {
    const rows = await asRole(database.applicationUrl, async (pg) => {
      const { rows } = await pg.query<{ name: string; concurrency: number | null }>(
        "SELECT name, concurrency FROM dbos.queues ORDER BY name",
      );
      return rows;
    });

    expect(rows).toEqual([
      { name: "actions", concurrency: 2 },
      { name: "llm", concurrency: 4 },
      { name: "resolve", concurrency: 1 },
    ]);
  });

  it("returns one DBOSClient to the web process, after the boot checks", async () => {
    client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
    const again = await getClient({
      appName: database.appName,
      databaseUrl: database.applicationUrl,
    });

    expect(again).toBe(client);
  }, 60_000);

  it("enqueues a bumped attempt into dbos.workflow_status in one transaction", async () => {
    control = createControlPool({ connectionString: database.applicationUrl });

    const bumped = await controlPlaneTx(control.pool, { operation: "case10-enqueue" }, async (pg) => {
      const attempt = await bumpAttempt(pg, RUN_ID);
      await client.enqueueInTransaction(pg, {
        queueName: QUEUE,
        workflowName: "case10Probe",
        workflowID: attempt.workflowId,
        // A version no process runs, so the running worker leaves the row alone: what is
        // under test is the enqueue reaching `dbos.workflow_status`, not dispatch, and
        // `case10Probe` is a flow no chunk has built yet.
        appVersion: `unrun-${randomUUID()}`,
      });
      return attempt;
    });

    expect(bumped.attempt).toBe(2);
    expect(bumped.workflowId).toBe(`${RUN_ID}:2`);

    const row = await asRole(database.applicationUrl, async (pg) => {
      const { rows } = await pg.query<{ name: string; queue_name: string }>(
        "SELECT name, queue_name FROM dbos.workflow_status WHERE workflow_uuid = $1",
        [bumped.workflowId],
      );
      return rows[0];
    });

    expect(row).toEqual({ name: "case10Probe", queue_name: QUEUE });
  }, 60_000);

  it("shuts the worker down cleanly", async () => {
    const exit = await worker.shutdown();

    expect(exit.code).toBe(0);
  }, 90_000);
});
