/**
 * The lines the worker fixture and the tests driving it agree on. Kept in a module of its
 * own so importing them does not pull in either side's machinery — the fixture would
 * otherwise load `node:child_process`, and a test would otherwise run the fixture.
 */
export const FIXTURE_READY = "hf-fixture: ready";
export const FIXTURE_FAILED = "hf-fixture: failed";
/** Printed once Sentry's `unhandledRejection` listener and the rejecting `shutdown` are in. */
export const FIXTURE_SENTRY_ARMED = "hf-fixture: rejecting shutdown armed behind Sentry";
/** Written to the fixture's stdin to ask for a clean `DBOS.shutdown()` and exit 0. */
export const FIXTURE_SHUTDOWN = "shutdown";
