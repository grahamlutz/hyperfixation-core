/** Module v2: a new ledger key in front of the gate and a new step behind it. */
import { runWorkerModule } from "@hyperfixation/testing/worker";
import { startWorker } from "@hyperfixation/workflows";
import { approvalFlow, type ApprovalFlowControl } from "./approval-flow.js";

approvalFlow({ classify: true, extraStepAfter: true });

await runWorkerModule<ApprovalFlowControl>({
  start: ({ appName, databaseUrl }) => startWorker({ appName, databaseUrl }),
});
