import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asRole, createTestDatabase, type TestDatabase } from "./database.js";
import { TEST_BUILD_SHA_PREFIX } from "./build-sha.js";
import { assertNoFencingFailure, spawnWorker, type SpawnedWorker } from "./spawn-worker.js";

const STEP_POOL_WORKER = fileURLToPath(
  new URL("./test-modules/step-pool-worker.ts", import.meta.url),
);

/**
 * The pipeline this package exists to give every other one: a database of its own, a worker
 * process spawned against it, and a clean shutdown. The worker that launches DBOS lives in
 * `@hyperfixation/workflows`, which drives the same harness from the other side.
 */
describe("spawnWorker against a per-run database", () => {
  let database: TestDatabase;
  let worker: SpawnedWorker | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await worker?.kill();
    await database?.drop();
  });

  it("migrates the fresh database and grants the application role", async () => {
    expect(database.databaseName).toMatch(/^hf_test_[0-9a-f]{12}$/);
    expect(database.migration.dbosSchemaGranted).toBe(true);

    const reachable = await asRole(database.applicationUrl, async (pg) => {
      const { rowCount } = await pg.query("SELECT 1 FROM hf_run");
      return rowCount;
    });

    expect(reachable).toBe(0);
  }, 60_000);

  it("brings a worker up on it and records when", async () => {
    worker = spawnWorker({
      module: STEP_POOL_WORKER,
      appName: database.appName,
      databaseUrl: database.applicationUrl,
    });

    await worker.ready();

    expect(worker.version.startsWith(TEST_BUILD_SHA_PREFIX)).toBe(true);
    expect(worker.readyAt()).toBeGreaterThan(0);
    expect(worker.exit()).toBeUndefined();
    assertNoFencingFailure(worker);
  }, 120_000);

  it("mints a different version for every worker it spawns", async () => {
    const other = spawnWorker({
      module: STEP_POOL_WORKER,
      appName: database.appName,
      databaseUrl: database.applicationUrl,
    });
    const exit = await other.kill();

    expect(other.version).not.toBe(worker?.version);
    expect(exit.signal).toBe("SIGKILL");
  }, 60_000);

  it("shuts it down cleanly over stdin", async () => {
    const exit = await worker!.shutdown();

    expect(exit).toEqual({ code: 0, signal: null });
  }, 60_000);

  it("rejects ready() with the worker's own message when it never comes up", async () => {
    const doomed = spawnWorker({
      module: STEP_POOL_WORKER,
      appName: database.appName,
      // Refused rather than unroutable, so the module's first statement fails in test time.
      databaseUrl: "postgresql://nobody@127.0.0.1:1/nowhere",
    });

    await expect(doomed.ready()).rejects.toThrow("hf-worker-fixture: failed");

    const exit = await doomed.exited;
    expect(exit.code).toBe(1);
  }, 60_000);
});
