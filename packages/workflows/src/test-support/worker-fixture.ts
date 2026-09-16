/**
 * A real worker process, which is the only shape in which `startWorker()` can be tested:
 * DBOS refuses a second launch in one process (`DBOSConflictingRegistrationError`), so
 * isolation and second-worker cases cannot be driven in-process.
 *
 * `@hyperfixation/testing`'s `spawnWorker` runs this and speaks the protocol on the other
 * side; everything below is what only a `startWorker()` fixture can supply.
 */
import { DBOS } from "@dbos-inc/dbos-sdk";
import { runWorkerModule } from "@hyperfixation/testing/worker";
import { startWorker } from "../start-worker.js";
import { SENTRY_ARMED_MARKER, type FixtureControl } from "./fixture-module.js";

await runWorkerModule<FixtureControl>({
  async start({ appName, databaseUrl, control }) {
    const rejectShutdownAfterMs = control.rejectShutdownAfterMs ?? 0;
    if (rejectShutdownAfterMs > 0) await armRejectingShutdown(rejectShutdownAfterMs);

    return startWorker({ appName, databaseUrl });
  },
});

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

  console.log(SENTRY_ARMED_MARKER);
}
