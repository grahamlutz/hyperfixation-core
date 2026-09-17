/** Module v1: the loop and nothing else. */
import { runWorkerModule } from "@hyperfixation/testing/worker";
import { startWorker } from "@hyperfixation/workflows";
import { llmFlow, type LlmFlowControl } from "./llm-flow.js";

llmFlow();

await runWorkerModule<LlmFlowControl>({
  start: ({ appName, databaseUrl }) => startWorker({ appName, databaseUrl }),
});
