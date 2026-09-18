/**
 * The third process the gate cases decide from: neither worker, so the decision travels the
 * same way a web request's would — a `pg` pool and a `DBOSClient` under the application role.
 *
 * Its kill variant is what makes "killed inside `decide()` before `COMMIT`" an arranged fact
 * rather than a timing guess: the pool it hands `decide()` intercepts the `COMMIT` statement
 * itself and hard-exits the process, so everything the transaction wrote is already written
 * and nothing of it is durable. The interception is the test's, not a seam in `decide()`.
 */
import type { WorkerControl } from "@hyperfixation/testing";
import { Pool, type PoolClient } from "pg";

export const DECIDE_POOL_SIZE = 2;

/** `<marker> <json>` once `decide()` returned. */
export const DECIDED_MARKER = "hf-decide-fixture: decided";

/** Printed immediately before the process kills itself in place of committing. */
export const KILLED_AT_COMMIT_MARKER = "hf-decide-fixture: killed before COMMIT";

/** The exit code of the killed variant; nothing else in the harness exits with it. */
export const KILLED_AT_COMMIT_EXIT = 9;

export interface DecideControl extends WorkerControl {
  approvalIds: number[];
  decisionKey: string;
  userId?: string;
  killBeforeCommit?: boolean;
}

export function decidePool(connectionString: string, killBeforeCommit = false): Pool {
  const pool = new Pool({ connectionString, max: DECIDE_POOL_SIZE });
  if (!killBeforeCommit) return pool;

  const connect = pool.connect.bind(pool);
  pool.connect = (async (): Promise<PoolClient> => {
    const client = await connect();
    const query = client.query.bind(client) as PoolClient["query"];
    client.query = ((...args: Parameters<PoolClient["query"]>) => {
      if (args[0] === "COMMIT") {
        console.log(KILLED_AT_COMMIT_MARKER);
        process.exit(KILLED_AT_COMMIT_EXIT);
      }
      return query(...args);
    }) as PoolClient["query"];
    return client;
  }) as typeof pool.connect;
  return pool;
}
