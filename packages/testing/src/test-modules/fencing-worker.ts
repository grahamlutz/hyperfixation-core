/**
 * A worker whose own code hits both production refusals and carries on, which is the shape a
 * bug in a future test's flow code takes: the process does not crash, so only the markers
 * `reportWorkerFailure` prints stop the test passing.
 */
import { DBOS } from "@dbos-inc/dbos-sdk";
import { assertNotInWorkflow, createStepPool } from "@hyperfixation/db";
import { reportWorkerFailure, runWorkerModule } from "../worker-module.js";
import type { WorkerControl } from "../worker-protocol.js";

interface FencingControl extends WorkerControl {
  statement: string;
  operation: string;
}

let steps: ReturnType<typeof createStepPool> | undefined;

await runWorkerModule<FencingControl>({
  async start({ databaseUrl, control }) {
    steps = createStepPool({ connectionString: databaseUrl });
    try {
      await steps.pool.query(control.statement);
    } catch (error) {
      reportWorkerFailure(error);
    }

    // `assertNotInWorkflow` reads `DBOS` on each call, so a stub is seen without a launch.
    DBOS.isWithinWorkflow = () => true;
    try {
      assertNotInWorkflow(control.operation);
    } catch (error) {
      reportWorkerFailure(error);
    }
  },
  async shutdown() {
    await steps?.end();
  },
});
