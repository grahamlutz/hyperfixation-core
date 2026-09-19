import { createStepPool, StaleAttempt, type StepPool } from "@hyperfixation/db";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createApprovalNotifier,
  NO_RECIPIENTS_MARKER,
  type ApprovalMessage,
} from "./approval-notifier.js";
import type { ApprovalNotice, ApprovalNotifier } from "./approvals.js";
import type { StepContext } from "./step.js";

describe("createApprovalNotifier", () => {
  let database: TestDatabase;
  let steps: StepPool;

  beforeAll(async () => {
    database = await createTestDatabase();
    steps = createStepPool({ connectionString: database.applicationUrl });
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query(
        "INSERT INTO hf_user (id, name, email) VALUES ('crystal', 'Crystal', 'crystal@test')",
      );
    });
  }, 60_000);

  afterAll(async () => {
    await steps?.end();
    await database?.drop();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The run the fence reads: `current_workflow_id` is the run id, as attempt 1's is. */
  async function context(runId: string, workflowId = runId): Promise<StepContext> {
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query(
        "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
          "VALUES ($1, 'test', '{}', 'running', 1, $1)",
        [runId],
      );
    });
    return {
      runId,
      attempt: 1,
      workflowId,
      key: "send",
      tx: (work) => steps.tx(runId, workflowId, work),
    };
  }

  function notice(overrides: Partial<ApprovalNotice> = {}): ApprovalNotice {
    return {
      approvalId: 41,
      runId: "run-1",
      key: "send",
      type: "send-email",
      draft: { body: "draft" },
      assigneeId: "crystal",
      recordType: "lead",
      recordId: "lead-1",
      expiresAt: new Date("2026-09-20T10:00:00.000Z"),
      ...overrides,
    };
  }

  /** The recipients function the template will own: the assignee's address, read through `ctx.tx`. */
  const assigneeEmail = (at: ApprovalNotice, ctx: StepContext): Promise<string[]> =>
    ctx.tx(async (db) => {
      const { rows } = await db.execute<{ email: string }>(sql`
        SELECT email FROM hf_user WHERE id = ${at.assigneeId}
      `);
      return rows.map((row) => row.email);
    });

  function notifier(
    recipients: (at: ApprovalNotice, ctx: StepContext) => Promise<string[]>,
    appUrl = "https://workspace.test/",
  ): { notify: ApprovalNotifier; sent: ApprovalMessage[] } {
    const sent: ApprovalMessage[] = [];
    const notify = createApprovalNotifier({
      appUrl,
      recipients,
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    });
    return { notify, sent };
  }

  it("links straight to the approval, with the base URL's trailing slash trimmed", async () => {
    const ctx = await context("notifier-url");
    const { notify, sent } = notifier(assigneeEmail);

    await notify(notice({ approvalId: 7 }), ctx);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: ["crystal@test"],
      subject: "Approval needed: send-email",
      url: "https://workspace.test/w/approvals/7",
    });
    expect(sent[0]!.text).toContain("https://workspace.test/w/approvals/7");
    expect(sent[0]!.text).toContain("Record: lead lead-1");
    expect(sent[0]!.text).toContain("Expires: 2026-09-20T10:00:00.000Z");
    // Text only: an HTML body would be a second thing to escape a model's draft for.
    expect(sent[0]!.text).not.toContain("<");
  });

  it("sends nothing and warns once when there is nobody to notify", async () => {
    const ctx = await context("notifier-empty");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { notify, sent } = notifier(assigneeEmail);

    await notify(notice({ assigneeId: "ghost" }), ctx);

    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(NO_RECIPIENTS_MARKER);
    expect(warn.mock.calls[0]?.[0]).toContain("ghost");
  });

  /**
   * The recipient read is `ctx.tx`'s first statement after the fence, so a notifier running on
   * an attempt the run has moved off is refused with nothing delivered — the notify step's
   * `StaleAttempt` before the send, not after it.
   */
  it("is refused by the step's fence, before it sends, on a stale attempt", async () => {
    const ctx = await context("notifier-stale", "notifier-stale:2");
    const { notify, sent } = notifier(assigneeEmail);

    await expect(notify(notice(), ctx)).rejects.toThrow(StaleAttempt);

    expect(sent).toEqual([]);
  });
});
