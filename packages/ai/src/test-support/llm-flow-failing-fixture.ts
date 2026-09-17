/** Case 9's module v2: the run fails before it can reach the `started` row it left behind. */
import { runWorkerModule } from "@hyperfixation/testing/worker";
import { startWorker } from "@hyperfixation/workflows";
import { llmFlow, type LlmFlowControl } from "./llm-flow.js";

llmFlow({ throwBeforeLoop: true });

await runWorkerModule<LlmFlowControl>({
  start: ({ appName, databaseUrl }) => startWorker({ appName, databaseUrl }),
});
