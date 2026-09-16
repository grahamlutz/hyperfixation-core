import * as schema from "@hyperfixation/db";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

export const CONTROL_POOL_SIZE = 2;

export type ControlDatabase = NodePgDatabase<typeof schema>;

export interface ControlPool {
  readonly pool: Pool;
  readonly db: ControlDatabase;
  end(): Promise<void>;
}

/**
 * Core's own handle in the worker, carrying the writes whose fence is a predicate
 * (`WHERE current_workflow_id = …`) rather than a row lock. No fence wrapper: that is the
 * step pool's job.
 *
 * `@hyperfixation/db` holds the identical factory in `src/internal/`, which its `exports`
 * map deliberately does not resolve — "no export resolves to the control pool" is contract
 * surface, enforced by the resolver rather than by convention. Repeating ten lines of `pg`
 * boilerplate here is what keeps that structural.
 */
export function createControlPool(options: PoolConfig): ControlPool {
  const pool = new Pool({ max: CONTROL_POOL_SIZE, ...options });
  return { pool, db: drizzle(pool, { schema }), end: () => pool.end() };
}
