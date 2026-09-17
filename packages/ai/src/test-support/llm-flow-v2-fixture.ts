/** Module v2: one extra step in front of the loop, the shape a redeploy actually ships. */
import { runWorkerModule } from "@hyperfixation/testing/worker";
import { startWorker } from "@hyperfixation/workflows";
import { llmFlow, type LlmFlowControl } from "./llm-flow.js";

llmFlow({ extraStep: true });

await runWorkerModule<LlmFlowControl>({
  start: ({ appName, databaseUrl }) => startWorker({ appName, databaseUrl }),
});
