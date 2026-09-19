import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  asRole,
  createTestDatabase,
  spawnWorker,
  testBuildSha,
  type SpawnedWorker,
  type TestDatabase,
} from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";
import { decide } from "./approvals.js";
import { getClient, resetClient } from "./client.js";
import { createControlPool, type ControlPool } from "./control-pool.js";
import { runsStart } from "./runs.js";
import {
  approvalFlow,
  APPROVAL_KEY,
  DECISION_MARKER,
  NOTIFY_MARKER,
} from "./test-support/approval-flow.js";

const APPROVAL_MODULE = new URL("./test-support/approval-flow-fixture.ts", import.meta.url)
  .pathname;

describe("waitForApproval — the gate, the suspend, and the attempt decide() enqueues", () => {
  let database: TestDatabase;
  let control: ControlPool;
  let client: DBOSClient;
  let worker: SpawnedWorker;

  async function query<R extends Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<R[]> {
    const { rows } = await control.pool.query<R>(sql, values);
    return rows;
  }

  async function waitForStatus(runId: string, status: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await query<{ status: string }>(
        "SELECT status FROM hf_run WHERE run_id = $1",
        [runId],
      );
      if (rows[0]?.status === status) return;
      if (Date.now() > deadline) {
        throw new Error(`hf_run ${runId} never reached ${status} (still ${rows[0]?.status})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function counter(runId: string, key: string): Promise<number | undefined> {
    const rows = await query<{ count: number }>(
      "SELECT count FROM test_counter WHERE run_id = $1 AND step_key = $2",
      [runId, key],
    );
    return rows[0]?.count;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query(
        "CREATE TABLE test_counter (run_id text, step_key text, count int NOT NULL, " +
          "PRIMARY KEY (run_id, step_key))",
      );
      await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, '10')");
    });

    worker = spawnWorker({
      module: APPROVAL_MODULE,
      appName: database.appName,
      databaseUrl: database.applicationUrl,
    });
    await worker.ready();

    control = createControlPool({ connectionString: database.applicationUrl });
    client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
  }, 120_000);

  afterAll(async () => {
    await resetClient();
    await control?.end();
    await worker?.kill();
    await database?.drop();
  });

  it(
    "ends the attempt waiting on a pending row, then carries the decision into attempt 2",
    async () => {
      const runId = `approval-${testBuildSha()}`;
      await runsStart(control.pool, client, approvalFlow, {}, { runId });

      await waitForStatus(runId, "waiting");
      const [pending] = await query<{ id: string; status: string; notified_at: Date | null }>(
        "SELECT id, status, notified_at FROM hf_approval WHERE run_id = $1 AND key = $2",
        [runId, APPROVAL_KEY],
      );
      expect(pending).toMatchObject({ status: "pending" });
      expect(pending!.notified_at).not.toBeNull();
      expect(worker.output()).toContain(`${NOTIFY_MARKER} ${APPROVAL_KEY}`);
      // The workflow ended rather than parking in it: that is what makes the wait survive a
      // redeploy, and `waiting` is only reachable through `Suspend`.
      const [attempt1] = await query<{ status: string }>(
        "SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1",
        [runId],
      );
      expect(attempt1).toMatchObject({ status: "SUCCESS" });
      expect(await counter(runId, "after")).toBeUndefined();

      await decide(control.pool, client, {
        ids: [Number(pending!.id)],
        decision: "approved",
        via: "web",
        userId: "crystal",
        decisionKey: `web-${runId}`,
        edits: { [Number(pending!.id)]: { body: "crystal's words" } },
        schemaFor: () => z.object({ body: z.string() }),
      });

      await waitForStatus(runId, "done");
      expect(worker.output()).toContain(
        `${DECISION_MARKER} ${JSON.stringify({ status: "approved", draft: { body: "crystal's words" } })}`,
      );
      expect(await counter(runId, "after")).toBe(1);
      // Attempt 2 runs the flow from the top, so everything before the gate runs again: the
      // documented cost of ending the workflow instead of parking inside it.
      expect(await counter(runId, "before")).toBe(2);
      expect(await query("SELECT attempt FROM hf_run WHERE run_id = $1", [runId])).toEqual([
        { attempt: 2 },
      ]);
    },
    180_000,
  );
});
