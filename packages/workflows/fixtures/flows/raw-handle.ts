/**
 * Redeploy case 5's second fixture: the raw-database-handle hint inside a flows directory.
 *
 * The write below is refused by the step pool at runtime whatever this file says, so the lint
 * error is only the fast version of that refusal. See the config's own test for the hole this
 * rule has by construction — a helper outside `flows/` importing the same handle is lint-legal.
 */
import { db } from "@/db";
import { createStepPool } from "@hyperfixation/db/src/step-pool.js";

export async function touchRecord(recordId: string): Promise<void> {
  await db.execute(`UPDATE app_record SET touched_at = now() WHERE id = '${recordId}'`);
  createStepPool({ databaseUrl: process.env.DATABASE_URL ?? "" });
}
