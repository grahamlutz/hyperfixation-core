/** The child half for `run-flow-sync.test.ts`: registers all three flows and runs a worker. */
import { runWorkerModule } from "@hyperfixation/testing/worker";
import { startWorker } from "../start-worker.js";
import "./insert-flow.js";
import "./unfenced-flow.js";
import "./upsert-flow.js";

await runWorkerModule({
  start: ({ appName, databaseUrl }) => startWorker({ appName, databaseUrl }),
});
