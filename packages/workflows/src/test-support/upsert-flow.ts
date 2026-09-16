/**
 * A single flow, importable by both a test (for its name/key constants and to enqueue it) and
 * the fixture entrypoint that runs it (`upsert-flow-fixture.ts`) — kept out of that entrypoint
 * so importing this file never runs `runWorkerModule()`, the same split `fixture-module.ts`
 * uses for the plain worker fixture.
 *
 * One step upserts a counter row, with a `parkFor()` call at each of the three points `killAt`
 * can target. What proves "ran once" is the counter itself — a step whose body re-ran would
 * leave it at 2, not 1.
 */
import { sql } from "drizzle-orm";
import { parkFor, workerControl } from "@hyperfixation/testing/worker";
import type { KillAtControl, WorkerControl } from "@hyperfixation/testing";
import { defineFlow } from "../define-flow.js";
import { step } from "../step.js";

export const UPSERT_FLOW_NAME = "upsertFlow";
export const UPSERT_STEP_KEY = "counter";

export interface UpsertFlowControl extends WorkerControl {
  killAt?: KillAtControl;
}

export const upsertFlow = defineFlow<Record<string, never>, void>(
  UPSERT_FLOW_NAME,
  async (_input, run) => {
    const control = workerControl<UpsertFlowControl>();

    await step(
      "upsert",
      async (ctx) => {
        await parkFor(control.killAt, "before-checkpoint", ctx.key);
        await ctx.tx(async (db) => {
          await parkFor(control.killAt, "in-tx", ctx.key);
          await db.execute(sql`
            INSERT INTO test_counter (run_id, step_key, count)
            VALUES (${run.runId}, ${ctx.key}, 1)
            ON CONFLICT (run_id, step_key) DO UPDATE SET count = test_counter.count + 1
          `);
        });
      },
      { key: UPSERT_STEP_KEY },
    );

    await parkFor(control.killAt, "after-checkpoint", UPSERT_STEP_KEY);
  },
  { queue: "resolve" },
);
