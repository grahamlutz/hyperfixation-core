/** The child half: registers `approvalFlow` (imported for its side effect) and runs a worker. */
import { runWorkerModule } from "@hyperfixation/testing/worker";
import { startWorker } from "../start-worker.js";
import "./approval-flow.js";

await runWorkerModule({
  start: ({ appName, databaseUrl }) => startWorker({ appName, databaseUrl }),
});
