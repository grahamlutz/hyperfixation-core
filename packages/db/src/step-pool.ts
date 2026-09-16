import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { fencePool, tagForTransaction } from "./fenced-client.js";
import * as schema from "./schema/index.js";

export const STEP_POOL_SIZE = 8;

/** `ctx.tx`'s first statement, and the only place the fencing token is read. */
export const FENCE_STATEMENT =
  "SELECT 1 FROM hf_run WHERE run_id = $1 AND current_workflow_id = $2 FOR SHARE";

export class StaleAttempt extends Error {
  readonly runId: string;
  readonly workflowId: string;

  constructor(runId: string, workflowId: string) {
    super(`StaleAttempt: hf_run ${runId} is no longer on attempt ${workflowId}`);
    this.name = "StaleAttempt";
    this.runId = runId;
    this.workflowId = workflowId;
  }
}

export type StepDatabase = NodePgDatabase<typeof schema>;

export type StepPoolOptions = PoolConfig;

export interface StepPool {
  /** The fenced `pg.Pool`: reads pass, writes are refused outside `ctx.tx`. */
  readonly pool: Pool;
  /** What an app's `@/db` resolves to in the worker. */
  readonly db: StepDatabase;
  tx<T>(runId: string, workflowId: string, work: (tx: StepDatabase) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/**
 * The only database handle step and app code are meant to reach. `runId`/`workflowId` are
 * explicit here; chunk 9 supplies them from the DBOS context.
 */
export function createStepPool(options: StepPoolOptions): StepPool {
  const pool = fencePool(new Pool({ max: STEP_POOL_SIZE, ...options }));

  return {
    pool,
    db: drizzle(pool, { schema }),
    async tx<T>(
      runId: string,
      workflowId: string,
      work: (tx: StepDatabase) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect();
      tagForTransaction(client);
      let broken: Error | undefined;
      try {
        await client.query("BEGIN");
        const fence = await client.query(FENCE_STATEMENT, [runId, workflowId]);
        if (fence.rowCount === 0) throw new StaleAttempt(runId, workflowId);
        const result = await work(drizzle(client, { schema }));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          // The connection is in an unknown transaction state; hand it back with the error
          // so the pool destroys it instead of leasing it to the next transaction.
          broken = rollbackError as Error;
        }
        throw error;
      } finally {
        client.release(broken);
      }
    },
    end: () => pool.end(),
  };
}
