/**
 * The flow `runFlowSync` has to reject: one step writing an *unkeyed* `INSERT` through
 * `ctx.tx`, which is fenced and legal and still leaves a second row when the run is restarted.
 * Importable by both the test and the fixture entrypoint, the same split `upsert-flow.ts` uses.
 */
import { sql } from "drizzle-orm";
import { defineFlow } from "../define-flow.js";
import { step } from "../step.js";

export const INSERT_FLOW_NAME = "insertFlow";
export const INSERT_STEP_KEY = "insert";

/** Written by this flow and attempted by `unfenced-flow.ts`; no unique key, on purpose. */
export const INSERT_TABLE = "test_insert";

export const INSERT_TABLE_DDL =
  `CREATE TABLE ${INSERT_TABLE} (run_id text NOT NULL, step_key text NOT NULL, ` +
  "written_at timestamptz NOT NULL DEFAULT clock_timestamp())";

export const insertFlow = defineFlow<Record<string, never>, void>(
  INSERT_FLOW_NAME,
  async (_input, run) => {
    await step(
      "insert",
      async (ctx) => {
        await ctx.tx(async (db) => {
          await db.execute(
            sql`INSERT INTO test_insert (run_id, step_key) VALUES (${run.runId}, ${ctx.key})`,
          );
        });
      },
      { key: INSERT_STEP_KEY },
    );
  },
  { queue: "resolve" },
);
