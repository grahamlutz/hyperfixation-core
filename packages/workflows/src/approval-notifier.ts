import type { ApprovalNotice, ApprovalNotifier } from "./approvals.js";
import type { StepContext } from "./step.js";

/**
 * Where the workspace serves one approval. Inline until `@hyperfixation/core/workspace` owns
 * the route; this notifier is then to take the path from its `approvalPath()`.
 */
function approvalPath(approvalId: number): string {
  return `/w/approvals/${approvalId}`;
}

/** Text only: a notification is a line and a link, and an HTML body is a second thing to escape. */
export interface ApprovalMessage {
  to: string[];
  subject: string;
  text: string;
  /** Also in `text`; separate so a channel that renders its own button has it. */
  url: string;
}

export interface ApprovalNotifierOptions {
  /** The workspace's base URL; a trailing slash is trimmed rather than doubled into the path. */
  appUrl: string;
  /**
   * Who to tell. Called with the step's context, so the read belongs to the step's own fenced
   * transaction — `ctx.tx` — and not to a pool of the notifier's own.
   */
  recipients(notice: ApprovalNotice, ctx: StepContext): Promise<string[]>;
  send(message: ApprovalMessage): Promise<void>;
}

/** `<marker> <json>`: an approval nobody could be told about, which is a wiring problem. */
export const NO_RECIPIENTS_MARKER = "hf-approval-notifier: no recipients";

/**
 * The notifier a worker hands `startWorker({ approvalNotifier })`: it resolves the recipients,
 * builds the one message and sends it.
 *
 * Zero recipients is warned about and sent to nobody. It is deliberately not a throw: the step
 * stamps `notified_at` once this returns, and failing here would leave the gate re-notifying
 * every attempt over a list that is not going to fill itself.
 */
export function createApprovalNotifier(options: ApprovalNotifierOptions): ApprovalNotifier {
  const base = options.appUrl.replace(/\/+$/, "");

  return async (notice, ctx) => {
    const url = `${base}${approvalPath(notice.approvalId)}`;
    // Before the send, so a bump that arrives while the gate is being re-entered is refused by
    // `ctx.tx`'s fence with nothing delivered.
    const to = await options.recipients(notice, ctx);
    if (to.length === 0) {
      console.warn(
        `${NO_RECIPIENTS_MARKER} ${JSON.stringify({
          approvalId: notice.approvalId,
          runId: notice.runId,
          key: notice.key,
          assigneeId: notice.assigneeId,
        })}`,
      );
      return;
    }
    await options.send({
      to,
      subject: `Approval needed: ${notice.type}`,
      text: body(notice, url),
      url,
    });
  };
}

function body(notice: ApprovalNotice, url: string): string {
  const lines = [`${notice.type} is waiting for a decision.`];
  if (notice.recordType !== null && notice.recordId !== null) {
    lines.push(`Record: ${notice.recordType} ${notice.recordId}`);
  }
  if (notice.expiresAt !== null) lines.push(`Expires: ${notice.expiresAt.toISOString()}`);
  lines.push("", `Decide: ${url}`, "");
  return lines.join("\n");
}
