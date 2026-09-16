import { setTimeout as delay } from "node:timers/promises";
import {
  createTestDatabase,
  spawnWorker,
  type SpawnedWorker,
  type TestDatabase,
} from "@hyperfixation/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  DRAIN_TIMEOUT_MS,
  SHUTDOWN_FAILED_MARKER,
  SHUTDOWN_IGNORED_MARKER,
  SHUTDOWN_MARKER,
} from "./start-worker.js";
import {
  SENTRY_ARMED_MARKER,
  WORKER_FIXTURE_MODULE,
  type FixtureControl,
} from "./test-support/fixture-module.js";

/** node-pg's message when two `shutdown()` calls both reach `pool.end()` — round-3 finding 9. */
const DOUBLE_END = "Called end on pool more than once";

/**
 * redeploy.test.ts case 11, round-3 findings 9 and 10. Both halves drive a real worker
 * process, because the handler's whole job is to end one.
 */
describe("redeploy case 11 — SIGTERM", () => {
  let database: TestDatabase | undefined;
  let worker: SpawnedWorker | undefined;

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
    // at all. With nothing enqueued the real drain finishes in under a millisecond, so
    // `drainMs` stands in for the mid-run worker chunk 9's flows do not yet exist to provide.
    //
    // What that reaches is the handler's guard, not node-pg's double `pool.end()` — with the
    // guard removed the second delivery gets its own delay and the first handler's
    // `process.exit(0)` still wins, which is the masking round-3 finding 9 describes. This
    // case discriminates on the marker count.
    worker = await bootWorker({ drainMs: 500 });

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
    await worker.waitFor(SENTRY_ARMED_MARKER);

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

  async function bootWorker(control: FixtureControl): Promise<SpawnedWorker> {
    database = await createTestDatabase();

    const spawned = spawnWorker({
      module: WORKER_FIXTURE_MODULE,
      appName: database.appName,
      databaseUrl: database.applicationUrl,
      control,
    });
    await spawned.ready();
    return spawned;
  }
});

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
