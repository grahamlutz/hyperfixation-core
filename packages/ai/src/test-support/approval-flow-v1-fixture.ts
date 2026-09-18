/** Module v1: the keys, the gate, the action. */
import { runWorkerModule } from "@hyperfixation/testing/worker";
import { startWorker } from "@hyperfixation/workflows";
import { approvalFlow, type ApprovalFlowControl } from "./approval-flow.js";

approvalFlow();

await runWorkerModule<ApprovalFlowControl>({
  start: ({ appName, databaseUrl }) => startWorker({ appName, databaseUrl }),
});
