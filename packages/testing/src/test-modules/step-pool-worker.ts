/**
 * The smallest worker this package can spawn without depending on `@hyperfixation/workflows`:
 * it opens the step pool on the per-run database and reads through it. Enough to prove the
 * database-plus-spawn pipeline end to end; a module that launches DBOS lives in whichever
 * package owns `startWorker()`.
 */
import { createStepPool } from "@hyperfixation/db";
import { runWorkerModule } from "../worker-module.js";

let steps: ReturnType<typeof createStepPool> | undefined;

await runWorkerModule({
  async start({ databaseUrl }) {
    steps = createStepPool({ connectionString: databaseUrl });
    await steps.pool.query("SELECT count(*) FROM hf_run");
  },
  async shutdown() {
    await steps?.end();
  },
});
