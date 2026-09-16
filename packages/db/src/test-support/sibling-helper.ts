import { eq, sql } from "drizzle-orm";
import { hfRun } from "../schema/runs.js";
import type { StepDatabase } from "../step-pool.js";

/**
 * Stands in for a helper an app keeps in `src/lib/` and imports from a flow: one import path,
 * one call site, refused or allowed purely by which connection the handle it is given holds.
 */
export async function stampVersion(db: StepDatabase, runId: string, version: string): Promise<void> {
  await db.update(hfRun).set({ version }).where(eq(hfRun.runId, runId));
}

export async function countRuns(db: StepDatabase): Promise<number> {
  const result = await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM hf_run`);
  return Number(result.rows[0]!.n);
}
