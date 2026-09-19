/**
 * The smallest worker this package can spawn without depending on `@hyperfixation/workflows`:
 * it opens the step pool on the per-run database and reads through it. Enough to prove the
 * database-plus-spawn pipeline end to end; a module that launches DBOS lives in whichever
 * package owns `startWorker()`.
 */
import { createStepPool } from "@hyperfixation/db";
import { runWorkerModule, workerClock } from "../worker-module.js";

let steps: ReturnType<typeof createStepPool> | undefined;

/** Duplicated as a literal in `spawn-worker.test.ts`: importing this module would run it. */
const TICK_MARKER = "step-pool-worker: clock";
const clock = workerClock();

// A `tick` line answers with whatever the worker's clock says now, which is the only way a test
// can see that `clockAt` and a live `clock <iso>` line reached the child.
process.stdin.on("data", (chunk: Buffer | string) => {
  for (const line of String(chunk).split("\n")) {
    if (line.trim() === "tick") console.log(`${TICK_MARKER} ${clock().toISOString()}`);
  }
});

await runWorkerModule({
  async start({ databaseUrl }) {
    steps = createStepPool({ connectionString: databaseUrl });
    await steps.pool.query("SELECT count(*) FROM hf_run");
  },
  async shutdown() {
    await steps?.end();
  },
});
