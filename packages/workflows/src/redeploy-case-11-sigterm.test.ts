import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { migrate } from "@hyperfixation/db/migrator";
import { afterEach, describe, expect, it } from "vitest";
import {
  DRAIN_TIMEOUT_MS,
  SHUTDOWN_FAILED_MARKER,
  SHUTDOWN_IGNORED_MARKER,
  SHUTDOWN_MARKER,
} from "./start-worker.js";
import { createTestDatabase, type TestDatabase } from "./test-support/database.js";
import { FIXTURE_READY, FIXTURE_SENTRY_ARMED } from "./test-support/fixture-protocol.js";
import { spawnFixture, type Fixture } from "./test-support/spawn-fixture.js";

/** node-pg's message when two `shutdown()` calls both reach `pool.end()` — round-3 finding 9. */
const DOUBLE_END = "Called end on pool more than once";

/**
 * redeploy.test.ts case 11, round-3 findings 9 and 10. Both halves drive a real worker
 * process, because the handler's whole job is to end one.
 */
describe("redeploy case 11 — SIGTERM", () => {
  let database: TestDatabase | undefined;
  let worker: Fixture | undefined;

  // The child outlives a failed assertion otherwise: every path through these tests leaves it
  // either exited or SIGKILLed.
  afterEach(async () => {
    await worker?.kill();
    await database?.drop();
    worker = undefined;
    database = undefined;
  });

  it("treats a second SIGTERM 50ms later as a no-op and exits 0", async () => {
    // The drain has to still be open 50ms in for the second delivery to be a second delivery
    // at all; see the fixture's `delayShutdown`.
    worker = await bootWorker({ delayShutdownMs: 500 });

    const started = performance.now();
    worker.child.kill("SIGTERM");
    await delay(50);
    worker.child.kill("SIGTERM");
    const exit = await worker.exited;
    const elapsedMs = performance.now() - started;

    expect(exit.code).toBe(0);
    expect(elapsedMs).toBeLessThan(DRAIN_TIMEOUT_MS);
    expect(occurrences(worker.output(), SHUTDOWN_MARKER)).toBe(1);
    expect(worker.output()).toContain(SHUTDOWN_IGNORED_MARKER);
    expect(worker.output()).not.toContain(DOUBLE_END);
  }, 180_000);

  /**
   * The bound that matters is 1 s against the 75 s watchdog: an `await`-shaped handler would
   * have its rejection swallowed by Sentry's listener and ride the watchdog out, so the
   * generous test timeout is deliberate — the failure should be this assertion reporting ~75 s,
   * not vitest timing out with nothing to say.
   */
  it("exits 1 within a second when shutdown rejects behind Sentry's listener", async () => {
    worker = await bootWorker({ rejectShutdownAfterMs: 200 });
    await worker.waitFor(FIXTURE_SENTRY_ARMED);

    const started = performance.now();
    worker.child.kill("SIGTERM");
    const exit = await worker.exited;
    const elapsedMs = performance.now() - started;

    expect(exit.code).toBe(1);
    // Ahead of the marker check so an `await`-shaped regression fails saying "75000", not
    // "missing log line" — the watchdog also exits 1, so the code alone does not tell them apart.
    expect(elapsedMs).toBeLessThan(1_000);
    expect(worker.output()).toContain(SHUTDOWN_FAILED_MARKER);
  }, 180_000);

  async function bootWorker(
    options: { delayShutdownMs?: number; rejectShutdownAfterMs?: number } = {},
  ): Promise<Fixture> {
    database = await createTestDatabase();
    await migrate(database.migratorUrl, { appName: database.appName });

    const fixture = spawnFixture({
      appName: database.appName,
      databaseUrl: database.applicationUrl,
      buildSha: `test-${randomUUID()}`,
      ...options,
    });
    await fixture.waitFor(FIXTURE_READY);
    return fixture;
  }
});

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
