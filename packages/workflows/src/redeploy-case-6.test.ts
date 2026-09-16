import {
  createTestDatabase,
  spawnWorker,
  testBuildSha,
  WORKER_READY,
  type SpawnedWorker,
  type TestDatabase,
} from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LAUNCHING_MARKER } from "./start-worker.js";
import { WORKER_FIXTURE_MODULE } from "./test-support/fixture-module.js";

/**
 * redeploy.test.ts case 6 — advisory-lock isolation. Two workers for one app never run at
 * once, and the second does not get as far as `DBOS.launch()`: the lock is what stops the
 * old version's step bodies and the new version's from overlapping, so a second launch
 * followed by a refusal would be no protection at all.
 */
describe("redeploy case 6 — a second worker exits without launching", () => {
  let database: TestDatabase;
  let first: SpawnedWorker | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await first?.kill();
    await database?.drop();
  });

  it("refuses the second worker, and never reaches DBOS.launch in it", async () => {
    // One version for both: what keeps them apart is the lock, not the application version.
    const version = testBuildSha();
    const spawn = (): SpawnedWorker =>
      spawnWorker({
        module: WORKER_FIXTURE_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
        version,
      });

    first = spawn();
    await first.ready();

    const second = spawn();
    const exit = await second.exited;

    expect(exit.code).toBe(1);
    expect(second.output()).toContain("WorkerLockUnavailable");
    expect(second.output()).not.toContain(LAUNCHING_MARKER);
    expect(second.output()).not.toContain(WORKER_READY);
  }, 180_000);

  it("leaves the first worker running and holding the lock", () => {
    expect(first?.exit()).toBeUndefined();
  });
});
