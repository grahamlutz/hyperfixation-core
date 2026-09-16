/** The child half: registers `upsertFlow` (imported for its side effect) and runs a worker. */
import { runWorkerModule } from "@hyperfixation/testing/worker";
import { startWorker } from "../start-worker.js";
import type { UpsertFlowControl } from "./upsert-flow.js";
import "./upsert-flow.js";

await runWorkerModule<UpsertFlowControl>({
  start: ({ appName, databaseUrl }) => startWorker({ appName, databaseUrl }),
});
