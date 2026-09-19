/** The child half: a worker that carries an `approvalNotifier`, plus `notifierFlow`. */
import { runWorkerModule } from "@hyperfixation/testing/worker";
import { startWorker } from "../start-worker.js";
import { fixtureNotifier } from "./notifier-flow.js";
import "./notifier-flow.js";

await runWorkerModule({
  start: ({ appName, databaseUrl }) =>
    startWorker({ appName, databaseUrl, approvalNotifier: fixtureNotifier() }),
});
