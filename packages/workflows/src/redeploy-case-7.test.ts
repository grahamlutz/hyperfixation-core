import { setTimeout as delay } from "node:timers/promises";
import {
  assertNoFencingFailure,
  asRole,
  createTestDatabase,
  killAt,
  parkedMarker,
  spawnWorker,
  testBuildSha,
  type SpawnedWorker,
  type TestDatabase,
} from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClient, resetClient } from "./client.js";
import { createControlPool, type ControlPool } from "./control-pool.js";
import { reconcile } from "./reconcile.js";
import { runsStart } from "./runs.js";
import {
  SHUTDOWN_RETURNED_MARKER,
  STALE_ATTEMPT_MARKER,
  WRITER_STEP_KEY,
  writerFlow,
} from "./test-support/writer-flow.js";
import { LOCK_ACQUIRED_MARKER } from "./worker-lock.js";

const WRITER_MODULE = new URL("./test-support/writer-flow-fixture.ts", import.meta.url).pathname;

/** The plan's numbers for the process half: 60 rows, 250 ms apart, `SIGTERM` at 6 s. */
const ROWS = 60;
const INTERVAL_MS = 250;
const SIGTERM_AFTER_MS = 6_000;
const DRAIN_MS = 3_000;

/**
 * A writes slower than the plan's 250 ms, and only A. `DBOS.shutdown()` waits `DRAIN_TIMEOUT_MS`
 * for a workflow running here, so at the plan's cadence the step simply finishes inside the
 * drain and there is nothing for the next worker to take over — the state round-2 finding 1 is
 * about is the one where the drain *abandons* the step with its bodies still writing. Sixty
 * rows two seconds apart leaves ~114 s of work when the drain starts counting.
 */
const SLOW_INTERVAL_MS = 2_000;

/** What "A's pid is gone" is allowed to cost once its drain has returned. */
const EXIT_BUDGET_MS = 500;

async function createWriterTables(database: TestDatabase): Promise<void> {
  await asRole(database.migratorUrl, async (pg) => {
    await pg.query(
      "CREATE TABLE test_write (run_id text NOT NULL, attempt int NOT NULL, writer text NOT NULL, " +
        "seq int NOT NULL, written_at timestamptz NOT NULL DEFAULT clock_timestamp(), " +
        "PRIMARY KEY (run_id, attempt, seq))",
    );
    await pg.query(
      "CREATE TABLE test_shared (id int PRIMARY KEY, writer text NOT NULL, attempt int NOT NULL, " +
        "updated_at timestamptz NOT NULL DEFAULT clock_timestamp())",
    );
  });
}

interface WriteRow {
  attempt: number;
  writer: string;
  seq: number;
  written_at: Date;
}

async function writes(database: TestDatabase, runId: string): Promise<WriteRow[]> {
  return asRole(database.applicationUrl, async (pg) => {
    const { rows } = await pg.query<WriteRow>(
      "SELECT attempt, writer, seq, written_at FROM test_write WHERE run_id = $1 " +
        "ORDER BY attempt, seq",
      [runId],
    );
    return rows;
  });
}

async function sharedRow(
  database: TestDatabase,
): Promise<{ writer: string; attempt: number } | undefined> {
  return asRole(database.applicationUrl, async (pg) => {
    const { rows } = await pg.query<{ writer: string; attempt: number }>(
      "SELECT writer, attempt FROM test_shared WHERE id = 1",
    );
    return rows[0];
  });
}

async function runRow(
  database: TestDatabase,
  runId: string,
): Promise<{ status: string; attempt: number; current_workflow_id: string } | undefined> {
  return asRole(database.applicationUrl, async (pg) => {
    const { rows } = await pg.query<{
      status: string;
      attempt: number;
      current_workflow_id: string;
    }>("SELECT status, attempt, current_workflow_id FROM hf_run WHERE run_id = $1", [runId]);
    return rows[0];
  });
}

async function waitFor(
  what: string,
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(150);
  }
}

/** The database clock the worker read in the same statement as `pg_try_advisory_lock`. */
function lockAcquiredAt(worker: SpawnedWorker): Date {
  const match = new RegExp(`${LOCK_ACQUIRED_MARKER} \\S+ (\\S+)`).exec(worker.output());
  if (match === null) throw new Error(`worker never logged ${LOCK_ACQUIRED_MARKER}`);
  return new Date(match[1]!);
}

/**
 * Redeploy case 7, round-2 finding 1: the *process* half. The escape the finding found was a
 * previous worker's step bodies still writing while the next worker had already taken over.
 * The fix is that the advisory lock is released by nothing but process death, so this case is
 * an ordering assertion — everything A committed happened before B could hold the lock — and
 * the `writer` column is what makes the ordering readable after the fact.
 */
describe("redeploy case 7 — a draining worker never overlaps its replacement", () => {
  let database: TestDatabase;
  let control: ControlPool;
  let workerA: SpawnedWorker | undefined;
  let workerB: SpawnedWorker | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
    await createWriterTables(database);
    control = createControlPool({ connectionString: database.applicationUrl });
  }, 60_000);

  afterAll(async () => {
    await resetClient();
    await workerA?.kill().catch(() => undefined);
    await workerB?.kill().catch(() => undefined);
    await control?.end();
    await database?.drop();
  });

  it(
    "hands the lock over only once A is dead, and attempt 2 writes its own rows",
    async () => {
      const versionA = testBuildSha();
      const versionB = testBuildSha();
      const runId = `case7-${versionA}`;

      workerA = spawnWorker({
        module: WRITER_MODULE,
        version: versionA,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
        drainMs: DRAIN_MS,
        control: { intervalMs: SLOW_INTERVAL_MS },
      });
      await workerA.ready();

      const client = await getClient({
        appName: database.appName,
        databaseUrl: database.applicationUrl,
      });
      await runsStart(control.pool, client, writerFlow, { rows: ROWS }, { runId });

      const startedAt = performance.now();
      await waitFor("A's first committed write", async () => (await writes(database, runId)).length > 0, 60_000);
      await delay(Math.max(0, SIGTERM_AFTER_MS - (performance.now() - startedAt)));

      workerA.child.kill("SIGTERM");
      // Immediately, as the finding's scenario has it: B spends A's whole drain polling for a
      // lock it must not get, which is the window the escape used to live in.
      workerB = spawnWorker({
        module: WRITER_MODULE,
        version: versionB,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
        control: { lockPollMs: 100, intervalMs: INTERVAL_MS },
      });

      // The drain is `DRAIN_TIMEOUT_MS` long and A's step outlasts it, so this is the wait for
      // the abandon, not for the step.
      await workerA.waitFor(SHUTDOWN_RETURNED_MARKER, 120_000);
      const drainReturnedAt = performance.now();
      const exitA = await workerA.exited;
      expect(exitA.code).toBe(0);
      expect(performance.now() - drainReturnedAt).toBeLessThan(EXIT_BUDGET_MS);

      await workerB.ready(120_000);

      const attemptOne = (await writes(database, runId)).filter((row) => row.attempt === 1);
      // The step was mid-loop when the drain abandoned it: some rows, not all of them. Without
      // this the ordering assertions below would hold vacuously on a run that simply finished.
      expect(attemptOne.length).toBeGreaterThan(0);
      expect(attemptOne.length).toBeLessThan(ROWS);
      expect(attemptOne.every((row) => row.writer === versionA)).toBe(true);

      const lastWriteA = attemptOne.at(-1)!.written_at;
      expect(lockAcquiredAt(workerB).getTime()).toBeGreaterThan(lastWriteA.getTime());

      await waitFor(
        "the run to finish under B",
        async () => (await runRow(database, runId))?.status === "done",
        300_000,
      );

      const attemptTwo = (await writes(database, runId)).filter((row) => row.attempt === 2);
      expect(attemptTwo).toHaveLength(ROWS);
      expect(attemptTwo.every((row) => row.writer === versionB)).toBe(true);
      expect(await sharedRow(database)).toEqual({ writer: versionB, attempt: 2 });
      expect(await runRow(database, runId)).toMatchObject({
        status: "done",
        attempt: 2,
        current_workflow_id: `${runId}:2`,
      });

      assertNoFencingFailure(workerA);
      assertNoFencingFailure(workerB);
      await workerB.shutdown();
    },
    600_000,
  );
});

/** How long A waits between iterations here, so the bump lands well before its next `ctx.tx`. */
const IN_TX_INTERVAL_MS = 3_000;

/** How long the bump is watched for not completing while A holds its transaction open. */
const BLOCKED_FOR_MS = 1_000;

/**
 * Redeploy case 7's `in-tx` half. A is parked inside an open `ctx.tx`, past the fence
 * statement's `FOR SHARE`, which is exactly the row the redeploy's bump needs `FOR UPDATE`:
 * the bump waits rather than racing. The bump is driven here rather than by a second worker
 * because A still holds the advisory lock — a worker B could not launch at all, which is the
 * first half's point.
 */
describe("redeploy case 7 — a bump waits on a held ctx.tx, and the attempt it moves goes stale", () => {
  let database: TestDatabase;
  let control: ControlPool;
  let worker: SpawnedWorker | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
    await createWriterTables(database);
    control = createControlPool({ connectionString: database.applicationUrl });
  }, 60_000);

  afterAll(async () => {
    await resetClient();
    await worker?.kill().catch(() => undefined);
    await control?.end();
    await database?.drop();
  });

  it(
    "blocks the bump, then refuses the stale ctx.tx and the bare UPDATE",
    async () => {
      const versionA = testBuildSha();
      const versionB = testBuildSha();
      const runId = `case7-intx-${versionA}`;
      const parkedAt = killAt(WRITER_STEP_KEY, "in-tx");

      worker = spawnWorker({
        module: WRITER_MODULE,
        version: versionA,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
        control: { killAt: parkedAt, bareUpdateAfterTx: true, intervalMs: IN_TX_INTERVAL_MS },
      });
      await worker.ready();

      const client = await getClient({
        appName: database.appName,
        databaseUrl: database.applicationUrl,
      });
      await runsStart(control.pool, client, writerFlow, { rows: 3 }, { runId });
      await worker.waitFor(parkedMarker(parkedAt), 60_000);

      const startedAt = performance.now();
      const pass = reconcile(control.pool, client, { applicationVersion: versionB });
      let settled = false;
      const watched = pass.then(
        (report) => {
          settled = true;
          return report;
        },
        (error: unknown) => {
          settled = true;
          throw error;
        },
      );

      await delay(BLOCKED_FOR_MS);
      expect(settled).toBe(false);

      worker.release();
      const report = await watched;
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(BLOCKED_FOR_MS);
      expect(report.failures).toEqual([]);
      expect(report.reattempted.map((run) => run.runId)).toEqual([runId]);

      await worker.waitFor(STALE_ATTEMPT_MARKER, 60_000);

      // One row: the iteration that held the transaction. The iteration after the bump opened a
      // `ctx.tx` whose fence statement matched nothing and wrote nothing.
      const rows = await writes(database, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ attempt: 1, writer: versionA, seq: 1 });
      expect(worker.output()).toContain(`${STALE_ATTEMPT_MARKER} 2`);

      // The refusal is the worker's own, reported rather than detected: round 3 moved it out of
      // the testing package and into the step pool.
      expect(worker.fencingFailures()).toHaveLength(1);
      expect(worker.fencingFailures()[0]).toMatchObject({
        name: "UnfencedWrite",
        detail: expect.stringContaining("UPDATE test_shared") as unknown as string,
      });
      expect(await sharedRow(database)).toEqual({ writer: versionA, attempt: 1 });
    },
    300_000,
  );
});
