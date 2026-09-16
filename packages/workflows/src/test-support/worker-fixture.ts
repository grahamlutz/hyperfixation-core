/**
 * A real worker process, which is the only shape in which `startWorker()` can be tested:
 * DBOS refuses a second launch in one process (`DBOSConflictingRegistrationError`), so
 * isolation and second-worker cases cannot be driven in-process.
 *
 * Reads `HF_APP_NAME`, `HF_DATABASE_URL`, `HF_FIXTURE_DELAY_SHUTDOWN_MS` and
 * `HF_FIXTURE_REJECT_SHUTDOWN_MS`; `HF_PROCESS` and `HF_BUILD_SHA` are read by
 * `startWorker()` itself and are set by whoever spawns this. Prints `FIXTURE_READY` once
 * launched and `FIXTURE_FAILED <name>: <message>` on any refusal, then waits for either a
 * `FIXTURE_SHUTDOWN` line on stdin or a signal.
 *
 * Chunk 8 replaces this with `@hyperfixation/testing`'s `spawnWorker`/`killAt`.
 */
import { DBOS } from "@dbos-inc/dbos-sdk";
import { startWorker } from "../start-worker.js";
import {
  FIXTURE_FAILED,
  FIXTURE_READY,
  FIXTURE_SENTRY_ARMED,
  FIXTURE_SHUTDOWN,
} from "./fixture-protocol.js";

try {
  const delayShutdownMs = Number(process.env.HF_FIXTURE_DELAY_SHUTDOWN_MS ?? "");
  if (delayShutdownMs > 0) delayShutdown(delayShutdownMs);

  const rejectShutdownAfterMs = Number(process.env.HF_FIXTURE_REJECT_SHUTDOWN_MS ?? "");
  if (rejectShutdownAfterMs > 0) await armRejectingShutdown(rejectShutdownAfterMs);

  await startWorker({
    appName: required("HF_APP_NAME"),
    databaseUrl: required("HF_DATABASE_URL"),
  });
  console.log(FIXTURE_READY);
} catch (error) {
  const thrown = error as Error;
  console.error(`${FIXTURE_FAILED} ${thrown.name}: ${thrown.message}`);
  // Writes to a pipe are synchronous on POSIX, so the line above is out before this lands.
  process.exit(1);
}

// DBOS's dispatch loops hold the process open; stdin is how a test asks it to stop. SIGTERM is
// handled by `startWorker()` itself, which is what redeploy case 11 drives.
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (!chunk.includes(FIXTURE_SHUTDOWN)) return;
  DBOS.shutdown().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
});

/**
 * Stands in for redeploy case 11's mid-run worker, which chunk 9's flows do not yet exist to
 * provide: with nothing enqueued the drain finishes in under a millisecond and the second
 * SIGTERM arrives after the process is already gone, so the guard is never asked anything.
 * The real `DBOS.shutdown()` still runs; only its entry is delayed.
 *
 * What this reaches is the guard, not node-pg's double `pool.end()` — with the guard removed
 * the second delivery gets its own delay and the first handler's `process.exit(0)` still wins,
 * which is the masking round-3 finding 9 describes. Case 11 discriminates on the marker count.
 */
function delayShutdown(byMs: number): void {
  const shutdown = DBOS.shutdown.bind(DBOS);
  DBOS.shutdown = (options) =>
    new Promise<void>((resolve) => setTimeout(resolve, byMs)).then(() => shutdown(options));
}

/**
 * Redeploy case 11's second half. Sentry's `unhandledRejection` listener is the thing that
 * would swallow the rejection if the SIGTERM handler ever grew an `await`, so the two are
 * armed together or not at all. Only that one integration is installed — the default set
 * patches `pg` and `http` underneath the worker, which would be a confound — and the import
 * is lazy so an ordinary fixture never loads Sentry at all.
 */
async function armRejectingShutdown(afterMs: number): Promise<void> {
  const Sentry = await import("@sentry/node");
  Sentry.init({
    // Integrations are only set up for a client with a DSN; the transport is stubbed so the
    // captured rejection never leaves the process.
    dsn: "https://fixture@fixture.invalid/0",
    defaultIntegrations: false,
    integrations: [Sentry.onUnhandledRejectionIntegration()],
    skipOpenTelemetrySetup: true,
    transport: () => ({ send: () => Promise.resolve({}), flush: () => Promise.resolve(true) }),
  });
  if (process.listenerCount("unhandledRejection") === 0) {
    throw new Error("@sentry/node installed no unhandledRejection listener");
  }

  DBOS.shutdown = () =>
    new Promise<void>((_resolve, reject) => {
      setTimeout(() => reject(new Error("fixture: DBOS.shutdown rejected")), afterMs);
    });

  console.log(FIXTURE_SENTRY_ARMED);
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is unset`);
  return value;
}
