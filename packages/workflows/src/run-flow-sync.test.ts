import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  asRole,
  createTestDatabase,
  DOUBLE_CHARGE_COUNT_KEY,
  FencingFailureInTest,
  RestartChangedCounts,
  runFlowSync,
  spawnWorker,
  type FlowSyncHarness,
  type SpawnedWorker,
  type TestDatabase,
} from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClient, resetClient } from "./client.js";
import { createControlPool, type ControlPool } from "./control-pool.js";
import type { Flow } from "./define-flow.js";
import { runsStart } from "./runs.js";
import { INSERT_TABLE, INSERT_TABLE_DDL, insertFlow } from "./test-support/insert-flow.js";
import { unfencedFlow } from "./test-support/unfenced-flow.js";
import { UPSERT_STEP_KEY, upsertFlow } from "./test-support/upsert-flow.js";

/**
 * `runFlowSync` lives in `@hyperfixation/testing` and its fixtures cannot: they need
 * `defineFlow`, `step` and `startWorker` from this package, which `testing` may not import.
 * So the harness is tested from the side that can supply a real flow.
 */
const MODULE = new URL("./test-support/run-flow-sync-fixture.ts", import.meta.url).pathname;

const COUNTER_TABLE_DDL =
  "CREATE TABLE test_counter (run_id text, step_key text, count int NOT NULL, " +
  "PRIMARY KEY (run_id, step_key))";

describe("runFlowSync", () => {
  let database: TestDatabase;
  let control: ControlPool;
  let client: DBOSClient;
  let worker: SpawnedWorker;

  beforeAll(async () => {
    database = await createTestDatabase();
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query(COUNTER_TABLE_DDL);
      await pg.query(INSERT_TABLE_DDL);
    });

    worker = spawnWorker({
      module: MODULE,
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
    await worker?.kill().catch(() => undefined);
    await database?.drop();
  });

  /**
   * The registry holds `Flow<never, unknown>` — the bottom of the family, because input is
   * contravariant — so handing a flow to `runsStart` through the harness's `FlowRef` needs the
   * widening spelled out. The input's shape is the flow's own contract, checked by nothing here.
   */
  function harnessFor(tables: readonly string[]): FlowSyncHarness {
    return {
      pool: control.pool,
      client,
      worker,
      tables,
      start: (flow, input) => runsStart(control.pool, client, flow as Flow<unknown>, input),
    };
  }

  async function counterValue(runId: string): Promise<number | undefined> {
    const { rows } = await control.pool.query<{ count: number }>(
      "SELECT count FROM test_counter WHERE run_id = $1 AND step_key = $2",
      [runId, UPSERT_STEP_KEY],
    );
    return rows[0]?.count;
  }

  it(
    "runs a keyed upsert twice and reports both attempts",
    async () => {
      const result = await runFlowSync(harnessFor(["test_counter"]), upsertFlow, {});

      expect(result.attempts).toBe(2);
      expect(result.status).toBe("done");
      // Attempt 1's workflow id is the bare run id; `attemptWorkflowId` only suffixes from 2.
      expect(result.workflowIds).toEqual([result.runId, `${result.runId}:2`]);
      expect(result.counts["test_counter"]).toBe(1);
      expect(result.counts[DOUBLE_CHARGE_COUNT_KEY]).toBe(0);
      // The harness counts rows, not values, and this fixture's `count + 1` is where the two
      // come apart: the second attempt's body really does re-run, on the row the key pinned.
      expect(await counterValue(result.runId)).toBe(2);
    },
    120_000,
  );

  it(
    "rejects an unkeyed INSERT with the count the restart changed",
    async () => {
      const failure = await runFlowSync(harnessFor([INSERT_TABLE]), insertFlow, {}).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(RestartChangedCounts);
      const changed = failure as RestartChangedCounts;
      expect(changed.diff).toEqual({ [INSERT_TABLE]: { before: 1, after: 2 } });
      expect(changed.message).toContain(`${INSERT_TABLE}: 1 -> 2`);
    },
    120_000,
  );

  it(
    "rejects a write issued outside ctx.tx as a fencing failure, not a timeout",
    async () => {
      const startedAt = Date.now();
      const failure = await runFlowSync(harnessFor([INSERT_TABLE]), unfencedFlow, {}, {
        timeoutMs: 30_000,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(FencingFailureInTest);
      expect((failure as FencingFailureInTest).failures[0]?.name).toBe("UnfencedWrite");
      expect((failure as Error).message).toContain("UnfencedWrite");
      expect(Date.now() - startedAt).toBeLessThan(20_000);
    },
    120_000,
  );

  it(
    "runs one attempt when the restart is skipped",
    async () => {
      const result = await runFlowSync(harnessFor(["test_counter"]), upsertFlow, {}, {
        restart: { skip: "the fixture is covered by the first case" },
      });

      expect(result.attempts).toBe(1);
      expect(result.status).toBe("done");
      expect(result.workflowIds).toEqual([result.runId]);
      expect(await counterValue(result.runId)).toBe(1);
    },
    120_000,
  );
});
