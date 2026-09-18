/**
 * Round-2 finding 1's flow, importable by both the test and the fixture entrypoint that runs
 * it — the same split `upsert-flow.ts` uses, so importing this file never launches a worker.
 *
 * One step writes a row per iteration through `ctx.tx` and stamps a shared row with the
 * version that wrote it. Two workers overlapping is the failure the finding describes, and the
 * `writer` column is what makes an overlap visible after the fact rather than a timing guess.
 */
import { setTimeout as delay } from "node:timers/promises";
import { StaleAttempt } from "@hyperfixation/db";
import { parkFor, reportWorkerFailure, workerControl } from "@hyperfixation/testing/worker";
import type { KillAtControl, WorkerControl } from "@hyperfixation/testing";
import { sql } from "drizzle-orm";
import { defineFlow } from "../define-flow.js";
import { step } from "../step.js";
import { workerRuntime } from "../worker-runtime.js";

export const WRITER_FLOW_NAME = "writerFlow";

/** The plan names case 7's step `resolve`; `killAt('resolve', 'in-tx')` is its second half. */
export const WRITER_STEP_KEY = "resolve";

/** Printed by the worker's own `DBOS.shutdown()` wrapper once the drain has returned. */
export const SHUTDOWN_RETURNED_MARKER = "hf-case7: DBOS.shutdown returned";

/** `<marker> <seq>`: the iteration whose `ctx.tx` found the run had moved on. */
export const STALE_ATTEMPT_MARKER = "hf-case7: ctx.tx refused as stale at seq";

export interface WriterFlowInput {
  rows: number;
}

export interface WriterFlowControl extends WorkerControl {
  killAt?: KillAtControl;
  /**
   * How long the step waits between iterations. A property of the worker rather than of the
   * run because the two attempts of one run need different pacing: what the drain abandons is
   * decided by how much work is left when `DBOS.shutdown()` starts counting.
   */
  intervalMs: number;
  /**
   * Retries `startWorker()` this often while another process still holds the advisory lock.
   * Worker B is started while A is draining, so it has to poll rather than exit.
   */
  lockPollMs?: number;
  /** Issues a bare `UPDATE` on the step pool once the first `ctx.tx` has committed. */
  bareUpdateAfterTx?: boolean;
}

export const writerFlow = defineFlow<WriterFlowInput, void>(
  WRITER_FLOW_NAME,
  async (input, run) => {
    const control = workerControl<WriterFlowControl>();
    const writer = workerRuntime(WRITER_FLOW_NAME).applicationVersion;

    await step(
      "write",
      async (ctx) => {
        for (let seq = 1; seq <= input.rows; seq += 1) {
          try {
            await ctx.tx(async (db) => {
              if (seq === 1) await parkFor(control.killAt, "in-tx", ctx.key);
              await db.execute(sql`
                INSERT INTO test_write (run_id, attempt, writer, seq)
                VALUES (${run.runId}, ${run.attempt}, ${writer}, ${seq})
              `);
              await db.execute(sql`
                INSERT INTO test_shared (id, writer, attempt) VALUES (1, ${writer}, ${run.attempt})
                ON CONFLICT (id) DO UPDATE
                SET writer = excluded.writer, attempt = excluded.attempt, updated_at = clock_timestamp()
              `);
            });
          } catch (error) {
            if (error instanceof StaleAttempt) console.info(STALE_ATTEMPT_MARKER, seq);
            throw error;
          }

          if (seq === 1 && control.bareUpdateAfterTx === true) await bareUpdate(writer);
          await delay(control.intervalMs);
        }
      },
      { key: WRITER_STEP_KEY },
    );
  },
  { queue: "resolve" },
);

/**
 * The same write the step just made legally, issued on the step pool itself. Round 3 moved
 * this refusal into the worker, so the failure is reported rather than thrown: the test reads
 * it off the harness as a production `UnfencedWrite`, and the run carries on to the next
 * `ctx.tx`, which is the other thing case 7's second half asserts on.
 */
async function bareUpdate(writer: string): Promise<void> {
  const { steps } = workerRuntime(`${WRITER_FLOW_NAME} bare UPDATE`);
  try {
    await steps.pool.query("UPDATE test_shared SET writer = $1 WHERE id = 1", [writer]);
  } catch (error) {
    reportWorkerFailure(error);
    return;
  }
  throw new Error("the step pool accepted a bare UPDATE issued outside ctx.tx");
}
