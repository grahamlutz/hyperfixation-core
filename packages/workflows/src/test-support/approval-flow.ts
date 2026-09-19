/**
 * The approvals gate's flow, split from its fixture entrypoint the way `upsert-flow.ts` is:
 * a step before the gate, the gate, and a step after it. The counter the first step upserts is
 * what shows the two-workflow pattern from the outside — attempt 2 runs the flow from the top,
 * so the count is the number of attempts that reached the gate.
 */
import type { KillAtControl, WorkerControl } from "@hyperfixation/testing";
import { parkFor, workerControl } from "@hyperfixation/testing/worker";
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

/**
 * `killAt` target inside `waitForApproval`, reached with the approval row committed and
 * `notified_at` still NULL: the only point a crash *inside the gate* can be arranged from a
 * fixture, since the gate's own steps live in production code and park nowhere.
 */
export const NOTIFY_PARK_KEY = "approval:notify";

export interface ApprovalFlowInput {
  /** A second pending row on the same run, opened before the gate creates its own (3b). */
  extraKey?: string;
}

export interface ApprovalFlowControl extends WorkerControl {
  killAt?: KillAtControl;
}

export const approvalFlow = defineFlow<ApprovalFlowInput, void>(
  APPROVAL_FLOW_NAME,
  async (input, run) => {
    const control = workerControl<ApprovalFlowControl>();

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

    if (input.extraKey !== undefined) {
      await step(
        "open-extra",
        async (ctx) => {
          await ctx.tx(async (db) => {
            await db.execute(sql`
              INSERT INTO hf_approval (run_id, key, workflow_id, type, draft, status)
              VALUES (${run.runId}, ${input.extraKey}, ${ctx.workflowId}, ${APPROVAL_TYPE},
                      '{"body":"other"}'::jsonb, 'pending')
              ON CONFLICT (run_id, key) DO NOTHING
            `);
          });
        },
        { key: "open-extra" },
      );
    }

    const decision = await waitForApproval({
      key: APPROVAL_KEY,
      type: APPROVAL_TYPE,
      draft: { body: "draft" },
      notify: async (notice) => {
        console.log(`${NOTIFY_MARKER} ${notice.key}`);
        await parkFor(control.killAt, "before-checkpoint", NOTIFY_PARK_KEY);
      },
    });
    console.log(
      `${DECISION_MARKER} ${JSON.stringify({
        runId: run.runId,
        key: decision.key,
        status: decision.status,
        draft: decision.draft,
      })}`,
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
