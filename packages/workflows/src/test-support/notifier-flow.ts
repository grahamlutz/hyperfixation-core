/**
 * A flow whose only step is the gate, for the notifier the *worker* carries rather than the one
 * a `waitForApproval` call passes. The recipient query is the fixture's own — resolving the
 * assignee's address against `hf_user` is the app's job, which C6.7 gives the template.
 */
import type { KillAtControl, WorkerControl } from "@hyperfixation/testing";
import { parkFor, workerControl } from "@hyperfixation/testing/worker";
import { sql } from "drizzle-orm";
import { createApprovalNotifier } from "../approval-notifier.js";
import { waitForApproval, type ApprovalNotifier } from "../approvals.js";
import { defineFlow } from "../define-flow.js";

export const NOTIFIER_FLOW_NAME = "notifierFlow";
export const NOTIFIER_KEY = "send";
export const NOTIFIER_TYPE = "send-email";

/** Trailing slash on purpose: the factory trims it instead of doubling it into the path. */
export const NOTIFIER_APP_URL = "https://workspace.test/";

/** `<marker> <json of ApprovalMessage>`, once per message the worker's notifier sent. */
export const SENT_MARKER = "hf-notifier-fixture: sent";

/** `<marker> <key>`, printed by the `notify` a call passes for itself. */
export const OWN_NOTIFY_MARKER = "hf-notifier-fixture: own notify";

/** Parked inside `send`, so a crash lands with the message out and `notified_at` still NULL. */
export const NOTIFY_PARK_KEY = "approval:notify";

export interface NotifierFlowInput {
  /** Whose `hf_user.email` the message goes to; no row for it means no recipients. */
  assigneeId?: string;
  /** Passes a `notify` of its own, which the worker's notifier must not override. */
  ownNotify?: boolean;
}

export interface NotifierFlowControl extends WorkerControl {
  killAt?: KillAtControl;
}

export function fixtureNotifier(): ApprovalNotifier {
  const control = workerControl<NotifierFlowControl>();

  return createApprovalNotifier({
    appUrl: NOTIFIER_APP_URL,
    recipients: (notice, ctx) =>
      ctx.tx(async (db) => {
        const { rows } = await db.execute<{ email: string }>(sql`
          SELECT email FROM hf_user WHERE id = ${notice.assigneeId} ORDER BY email
        `);
        return rows.map((row) => row.email);
      }),
    send: async (message) => {
      console.log(`${SENT_MARKER} ${JSON.stringify(message)}`);
      await parkFor(control.killAt, "before-checkpoint", NOTIFY_PARK_KEY);
    },
  });
}

export const notifierFlow = defineFlow<NotifierFlowInput, void>(
  NOTIFIER_FLOW_NAME,
  async (input) => {
    await waitForApproval({
      key: NOTIFIER_KEY,
      type: NOTIFIER_TYPE,
      draft: { body: "draft" },
      assigneeId: input.assigneeId,
      // No record: this worker registers no record table, and E002 refuses a boot with an
      // `hf_approval` row naming one. The record lines are the notifier's own unit test's.
      expiresInMs: 3_600_000,
      ...(input.ownNotify === true
        ? {
            notify: (notice) => {
              console.log(`${OWN_NOTIFY_MARKER} ${notice.key}`);
              return Promise.resolve();
            },
          }
        : {}),
    });
  },
  { queue: "resolve" },
);
