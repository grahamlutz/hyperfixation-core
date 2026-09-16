/**
 * A real worker process, which is the only shape in which `startWorker()` can be tested:
 * DBOS refuses a second launch in one process (`DBOSConflictingRegistrationError`), so
 * isolation and second-worker cases cannot be driven in-process.
 *
 * Reads `HF_APP_NAME` and `HF_DATABASE_URL`; `HF_PROCESS` and `HF_BUILD_SHA` are read by
 * `startWorker()` itself and are set by whoever spawns this. Prints `FIXTURE_READY` once
 * launched and `FIXTURE_FAILED <name>: <message>` on any refusal, then waits for either a
 * `FIXTURE_SHUTDOWN` line on stdin or a signal.
 *
 * Chunk 8 replaces this with `@hyperfixation/testing`'s `spawnWorker`/`killAt`.
 */
import { DBOS } from "@dbos-inc/dbos-sdk";
import { startWorker } from "../start-worker.js";
import { FIXTURE_FAILED, FIXTURE_READY, FIXTURE_SHUTDOWN } from "./fixture-protocol.js";

try {
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

// DBOS's dispatch loops hold the process open; stdin is how a test asks it to stop. There is
// no SIGTERM handler here on purpose — that is chunk 7, and it gets its own gate case.
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

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is unset`);
  return value;
}
