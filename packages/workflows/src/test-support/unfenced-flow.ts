/**
 * A write issued on the step pool itself rather than through `ctx.tx`, and — unlike
 * `writer-flow.ts`'s `bareUpdate` — **not** caught: this is the helper that imported the raw
 * handle, so the refusal propagates out of the step, out of the workflow, and reaches a test
 * only as the text `defineFlow` wrote to `hf_run.error`.
 */
import { defineFlow } from "../define-flow.js";
import { step } from "../step.js";
import { workerRuntime } from "../worker-runtime.js";
import { INSERT_TABLE } from "./insert-flow.js";

export const UNFENCED_FLOW_NAME = "unfencedFlow";
export const UNFENCED_STEP_KEY = "unfenced";

export const unfencedFlow = defineFlow<Record<string, never>, void>(
  UNFENCED_FLOW_NAME,
  async (_input, run) => {
    await step(
      "unfenced",
      async (ctx) => {
        const { steps } = workerRuntime(`flow ${UNFENCED_FLOW_NAME}`);
        await steps.pool.query(`INSERT INTO ${INSERT_TABLE} (run_id, step_key) VALUES ($1, $2)`, [
          run.runId,
          ctx.key,
        ]);
        throw new Error("the step pool accepted an INSERT issued outside ctx.tx");
      },
      { key: UNFENCED_STEP_KEY },
    );
  },
  { queue: "resolve" },
);
