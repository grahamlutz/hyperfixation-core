import { randomUUID } from "node:crypto";
import { migrate } from "@hyperfixation/db/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LAUNCHING_MARKER } from "./start-worker.js";
import { createTestDatabase, type TestDatabase } from "./test-support/database.js";
import { FIXTURE_READY } from "./test-support/fixture-protocol.js";
import { spawnFixture, type Fixture } from "./test-support/spawn-fixture.js";

/**
 * redeploy.test.ts case 6 — advisory-lock isolation. Two workers for one app never run at
 * once, and the second does not get as far as `DBOS.launch()`: the lock is what stops the
 * old version's step bodies and the new version's from overlapping, so a second launch
 * followed by a refusal would be no protection at all.
 */
describe("redeploy case 6 — a second worker exits without launching", () => {
  let database: TestDatabase;
  let first: Fixture | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
    await migrate(database.migratorUrl, { appName: database.appName });
  }, 120_000);

  afterAll(async () => {
    await first?.kill();
    await database?.drop();
  });

  it("refuses the second worker, and never reaches DBOS.launch in it", async () => {
    const buildSha = `test-${randomUUID()}`;
    first = spawnFixture({
      appName: database.appName,
      databaseUrl: database.applicationUrl,
      buildSha,
    });
    await first.waitFor(FIXTURE_READY);

    const second = spawnFixture({
      appName: database.appName,
      databaseUrl: database.applicationUrl,
      buildSha,
    });
    const exit = await second.exited;

    expect(exit.code).toBe(1);
    expect(second.output()).toContain("WorkerLockUnavailable");
    expect(second.output()).not.toContain(LAUNCHING_MARKER);
    expect(second.output()).not.toContain(FIXTURE_READY);
  }, 180_000);

  it("leaves the first worker running and holding the lock", async () => {
    expect(first?.child.exitCode).toBeNull();
  });
});
