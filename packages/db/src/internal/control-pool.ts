import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "../schema/index.js";

export const CONTROL_POOL_SIZE = 2;

export type ControlDatabase = NodePgDatabase<typeof schema>;

export interface ControlPool {
  readonly pool: Pool;
  readonly db: ControlDatabase;
  end(): Promise<void>;
}

/**
 * Core's own control-plane handle: the same `pg.Pool` usage as the step pool with no fence,
 * because a control-plane operation's fence is a predicate (`WHERE current_workflow_id = …`)
 * rather than a row lock.
 *
 * Unreachable by construction, not by convention: `package.json`'s `exports` map resolves
 * only `.` (`src/index.ts`) and `./migrator`, neither of which re-exports this module, so
 * no `import "@hyperfixation/db/…"` from another package can produce a control pool.
 */
export function createControlPool(options: PoolConfig): ControlPool {
  const pool = new Pool({ max: CONTROL_POOL_SIZE, ...options });
  return { pool, db: drizzle(pool, { schema }), end: () => pool.end() };
}
