/** The deciding process: one `decide()` call, then it waits for the test to shut it down. */
import { runWorkerModule } from "@hyperfixation/testing/worker";
import { decide, getClient } from "@hyperfixation/workflows";
import { approvalFlow } from "./approval-flow.js";
import { decidePool, DECIDED_MARKER, type DecideControl } from "./decide-process.js";

// The flow registry is where the bump's queue name comes from, so a deciding process registers
// the app's flows exactly as the web process it stands in for does.
approvalFlow();

await runWorkerModule<DecideControl>({
  start: async ({ appName, databaseUrl, control }) => {
    const pool = decidePool(databaseUrl, control.killBeforeCommit === true);
    const client = await getClient({ appName, databaseUrl });
    const result = await decide(pool, client, {
      ids: control.approvalIds,
      decision: "approved",
      via: "web",
      userId: control.userId ?? "crystal",
      decisionKey: control.decisionKey,
    });
    console.log(`${DECIDED_MARKER} ${JSON.stringify(result)}`);
    await pool.end();
  },
  shutdown: () => Promise.resolve(),
});
