/**
 * The approvals gate's flow, split from its fixture entrypoint the way `upsert-flow.ts` is:
 * a step before the gate, the gate, and a step after it. The counter the first step upserts is
 * what shows the two-workflow pattern from the outside — attempt 2 runs the flow from the top,
 * so the count is the number of attempts that reached the gate.
 */
import { sql } from "drizzle-orm";
import { waitForApproval } from "../approvals.js";
import { defineFlow } from "../define-flow.js";
import { step } from "../step.js";

export const APPROVAL_FLOW_NAME = "approvalFlow";
export const APPROVAL_KEY = "send";
export const APPROVAL_TYPE = "send-email";

/** `<marker> <json>` once the gate returns a decision. */
export const DECISION_MARKER = "hf-approval-fixture: decision";

/** `<marker> <key>`, once per notification actually sent. */
export const NOTIFY_MARKER = "hf-approval-fixture: notified";

export const approvalFlow = defineFlow<Record<string, never>, void>(
  APPROVAL_FLOW_NAME,
  async (_input, run) => {
    await step(
      "before",
      async (ctx) => {
        await ctx.tx(async (db) => {
          await db.execute(sql`
            INSERT INTO test_counter (run_id, step_key, count)
            VALUES (${run.runId}, ${ctx.key}, 1)
            ON CONFLICT (run_id, step_key) DO UPDATE SET count = test_counter.count + 1
          `);
        });
      },
      { key: "before" },
    );

    const decision = await waitForApproval({
      key: APPROVAL_KEY,
      type: APPROVAL_TYPE,
      draft: { body: "draft" },
      notify: (notice) => {
        console.log(`${NOTIFY_MARKER} ${notice.key}`);
        return Promise.resolve();
      },
    });
    console.log(
      `${DECISION_MARKER} ${JSON.stringify({ status: decision.status, draft: decision.draft })}`,
    );

    await step(
      "after",
      async (ctx) => {
        await ctx.tx(async (db) => {
          await db.execute(sql`
            INSERT INTO test_counter (run_id, step_key, count)
            VALUES (${run.runId}, ${ctx.key}, 1)
            ON CONFLICT (run_id, step_key) DO UPDATE SET count = test_counter.count + 1
          `);
        });
      },
      { key: "after" },
    );
  },
  { queue: "resolve" },
);
