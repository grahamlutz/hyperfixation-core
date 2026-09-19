import { type DBOSClient } from "@dbos-inc/dbos-sdk";
import { asRole, createTestDatabase, testBuildSha, type TestDatabase } from "@hyperfixation/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decide, type DecideOptions, type DecideResult } from "./approvals.js";
import { getClient, resetClient } from "./client.js";
import { createControlPool, type ControlPool } from "./control-pool.js";
import { defineFlow, type Flow } from "./define-flow.js";
import { runsStart } from "./runs.js";
import {
  CALLBACK_DATA_MAX_BYTES,
  CallbackDataTooLong,
  decodeCallbackData,
  encodeCallbackData,
  handleTelegramCallback,
  maxNonceLength,
  type TelegramCallbackOptions,
  type TelegramDecision,
} from "./telegram.js";

let database: TestDatabase;
let control: ControlPool;
let client: DBOSClient;
let flow: Flow<{ n: number }, void>;

/** Never dispatched: no worker launches in this file, so the body is only here to be named. */
function callbackFlow(): Flow<{ n: number }, void> {
  return defineFlow<{ n: number }, void>("callbackFlow", () => Promise.resolve(), { queue: "llm" });
}

async function query<R extends Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<R[]> {
  const { rows } = await control.pool.query<R>(sql, values);
  return rows;
}

async function startRun(runId: string): Promise<void> {
  await runsStart(control.pool, client, flow, { n: 1 }, { runId });
  await query("UPDATE hf_run SET status = 'waiting' WHERE run_id = $1", [runId]);
}

async function pending(runId: string, assigneeId: string | null = null): Promise<number> {
  const rows = await query<{ id: string }>(
    "INSERT INTO hf_approval (run_id, key, workflow_id, type, draft, status, assignee_id) " +
      "VALUES ($1, 'send', $1, 'send-email', '{\"body\":\"draft\"}'::jsonb, 'pending', $2) " +
      "RETURNING id",
    [runId, assigneeId],
  );
  return Number(rows[0]!.id);
}

async function approval(id: number): Promise<Record<string, unknown> | undefined> {
  return (
    await query(
      "SELECT status, decided_by, decided_via, decision_key, batch_id, resume_workflow_id " +
        "FROM hf_approval WHERE id = $1",
      [id],
    )
  )[0];
}

async function run(runId: string): Promise<Record<string, unknown> | undefined> {
  return (
    await query("SELECT status, attempt, current_workflow_id FROM hf_run WHERE run_id = $1", [
      runId,
    ])
  )[0];
}

/** The `app.approvals.decide` a webhook route would hand the handler. */
const deciding: TelegramCallbackOptions = {
  decide: (options: DecideOptions): Promise<DecideResult> => decide(control.pool, client, options),
  userFor: (from) => `tg:${from.id}`,
};

function update(callbackData: string | undefined, queryId = "cbq-1"): unknown {
  return {
    update_id: 4242,
    callback_query: {
      id: queryId,
      from: { id: 777, username: "graham", is_bot: false },
      message: { message_id: 9, chat: { id: 777, type: "private" } },
      ...(callbackData === undefined ? {} : { data: callbackData }),
    },
  };
}

function press(approvalId: number, decision: TelegramDecision, nonce: string): unknown {
  return update(encodeCallbackData({ approvalId, decision, nonce }));
}

function runIdFor(name: string): string {
  return `${name}-${testBuildSha()}`;
}

beforeAll(async () => {
  database = await createTestDatabase();
  control = createControlPool({ connectionString: database.applicationUrl });
  client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
  flow = callbackFlow();
  await asRole(database.migratorUrl, async (pg) => {
    await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, '10')");
  });
}, 120_000);

afterAll(async () => {
  await resetClient();
  await control?.end();
  await database?.drop();
});

beforeEach(async () => {
  await query("DELETE FROM hf_approval");
  await query("DELETE FROM hf_audit");
  await query("DELETE FROM hf_activity");
  await query("DELETE FROM hf_run");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the callback data encoding", () => {
  it("round-trips an approve and a reject", () => {
    const approve = encodeCallbackData({ approvalId: 12, decision: "approved", nonce: "n0nce" });
    const reject = encodeCallbackData({ approvalId: 12, decision: "rejected", nonce: "n0nce" });

    expect(approve).toBe("hf1:a:12:n0nce");
    expect(reject).toBe("hf1:r:12:n0nce");
    expect(decodeCallbackData(approve)).toEqual({
      approvalId: 12,
      decision: "approved",
      nonce: "n0nce",
    });
    expect(decodeCallbackData(reject)).toEqual({
      approvalId: 12,
      decision: "rejected",
      nonce: "n0nce",
    });
  });

  it("fits Telegram's 64 bytes exactly at the longest nonce, and refuses one byte more", () => {
    const approvalId = 9_007_199_254_740_991;
    const longest = "z".repeat(maxNonceLength(approvalId));

    const encoded = encodeCallbackData({ approvalId, decision: "approved", nonce: longest });

    expect(Buffer.byteLength(encoded)).toBe(CALLBACK_DATA_MAX_BYTES);
    expect(decodeCallbackData(encoded)).toEqual({ approvalId, decision: "approved", nonce: longest });
    expect(() =>
      encodeCallbackData({ approvalId, decision: "approved", nonce: `${longest}z` }),
    ).toThrow(CallbackDataTooLong);
    // Nothing Telegram could deliver, so a 65-byte string is not ours however well-formed it looks.
    expect(decodeCallbackData(`${encoded}z`)).toBeNull();
  });

  it("decodes nothing it did not write", () => {
    for (const data of [
      undefined,
      "",
      "hf1:a:12",
      "hf1:a:12:n:extra",
      "hf0:a:12:n",
      "hf1:x:12:n",
      "hf1:a:0:n",
      "hf1:a:012:n",
      "hf1:a:-1:n",
      "hf1:a:1e3:n",
      "hf1:a:12:",
      "hf1:a:12:has space",
      "hf1:a:9007199254740993:n",
    ]) {
      expect(decodeCallbackData(data), JSON.stringify(data)).toBeNull();
    }
  });

  it("refuses a nonce the separator could not survive", () => {
    expect(() => encodeCallbackData({ approvalId: 1, decision: "approved", nonce: "a:b" })).toThrow(
      TypeError,
    );
  });
});

describe("handleTelegramCallback", () => {
  it("approves the pressed approval through decide(), via telegram", async () => {
    const runId = runIdFor("approve");
    await startRun(runId);
    const id = await pending(runId);

    const result = await handleTelegramCallback(press(id, "approved", "n1"), deciding);

    expect(result).toEqual({
      outcome: "decided",
      callbackQueryId: "cbq-1",
      approvalId: id,
      decision: "approved",
      decisionKey: `${id}:n1`,
      replayed: false,
      reason: null,
    });
    expect(await approval(id)).toMatchObject({
      status: "approved",
      decided_by: "tg:777",
      decided_via: "telegram",
      decision_key: `${id}:n1`,
      batch_id: null,
      resume_workflow_id: `${runId}:2`,
    });
    // The decision carries the run on, exactly as the inbox's would.
    expect(await run(runId)).toMatchObject({ status: "running", attempt: 2 });
  });

  it("rejects the pressed approval", async () => {
    const runId = runIdFor("reject");
    await startRun(runId);
    const id = await pending(runId);

    const result = await handleTelegramCallback(press(id, "rejected", "n1"), deciding);

    expect(result).toMatchObject({ outcome: "decided", decision: "rejected", replayed: false });
    expect(await approval(id)).toMatchObject({ status: "rejected", decided_via: "telegram" });
    expect(await run(runId)).toMatchObject({ attempt: 2 });
  });

  it("decides once when Telegram delivers the same press twice", async () => {
    const runId = runIdFor("replay");
    await startRun(runId);
    const id = await pending(runId);
    const pressed = press(id, "approved", "n1");

    const first = await handleTelegramCallback(pressed, deciding);
    const second = await handleTelegramCallback(pressed, deciding);

    expect(first).toMatchObject({ outcome: "decided", replayed: false });
    expect(second).toMatchObject({
      outcome: "decided",
      approvalId: id,
      decision: "approved",
      decisionKey: `${id}:n1`,
      replayed: true,
      reason: null,
    });
    // One decision: one audit row, one activity row, one bump, no second batch.
    expect(await query("SELECT id FROM hf_audit")).toHaveLength(1);
    expect(await query("SELECT id FROM hf_activity")).toHaveLength(1);
    expect(await run(runId)).toMatchObject({ attempt: 2 });
    expect(await approval(id)).toMatchObject({ decision_key: `${id}:n1`, batch_id: null });
  });

  it("refuses a nonce from a superseded message", async () => {
    const runId = runIdFor("stale");
    await startRun(runId);
    const id = await pending(runId);

    await handleTelegramCallback(press(id, "approved", "fresh"), deciding);
    const stale = await handleTelegramCallback(press(id, "rejected", "stale"), deciding);

    expect(stale).toMatchObject({
      outcome: "refused",
      approvalId: id,
      decisionKey: `${id}:stale`,
      replayed: false,
      reason: `${id} is already approved`,
    });
    expect(await approval(id)).toMatchObject({ status: "approved", decision_key: `${id}:fresh` });
    expect(await query("SELECT id FROM hf_activity")).toHaveLength(1);
    expect(await run(runId)).toMatchObject({ attempt: 2 });
  });

  it("refuses a callback naming an approval that does not exist", async () => {
    const result = await handleTelegramCallback(press(987_654, "approved", "n1"), deciding);

    expect(result).toMatchObject({
      outcome: "refused",
      approvalId: 987_654,
      reason: "987654 has no hf_approval row",
    });
  });

  it("ignores malformed data without reaching decide()", async () => {
    const decide = vi.fn<(options: DecideOptions) => Promise<DecideResult>>();

    for (const data of [undefined, "", "hf1:a:not-a-number:n1", "someone-elses-button"]) {
      expect(await handleTelegramCallback(update(data), { decide })).toMatchObject({
        outcome: "ignored",
        callbackQueryId: "cbq-1",
        approvalId: null,
        decisionKey: null,
      });
    }
    // An update that is not a callback_query at all: a message, a poll answer, anything.
    expect(await handleTelegramCallback({ update_id: 1, message: {} }, { decide })).toMatchObject({
      outcome: "ignored",
      callbackQueryId: null,
    });
    expect(await handleTelegramCallback(null, { decide })).toMatchObject({ outcome: "ignored" });
    expect(decide).not.toHaveBeenCalled();
  });

  it("ignores an update whose secret token does not match the webhook's", async () => {
    const decide = vi.fn<(options: DecideOptions) => Promise<DecideResult>>();
    const pressed = press(1, "approved", "n1");

    const wrong = await handleTelegramCallback(pressed, {
      decide,
      secret: { expected: "s3cret", received: "guess" },
    });
    const missing = await handleTelegramCallback(pressed, {
      decide,
      secret: { expected: "s3cret", received: undefined },
    });

    for (const result of [wrong, missing]) {
      expect(result).toMatchObject({ outcome: "ignored", callbackQueryId: null, approvalId: null });
    }
    expect(decide).not.toHaveBeenCalled();
  });

  it("lets a transient failure through, so the webhook's retry is Telegram's to make", async () => {
    const decide = vi.fn<(options: DecideOptions) => Promise<DecideResult>>(() =>
      Promise.reject(new Error("CommitLost")),
    );

    await expect(handleTelegramCallback(press(1, "approved", "n1"), { decide })).rejects.toThrow(
      "CommitLost",
    );
  });

  it("refuses a row assigned to somebody else, and decides it for an admin", async () => {
    const runId = runIdFor("assigned");
    await startRun(runId);
    const id = await pending(runId, "crystal");

    const refused = await handleTelegramCallback(press(id, "approved", "n1"), deciding);
    const decided = await handleTelegramCallback(press(id, "approved", "n2"), {
      ...deciding,
      admin: true,
    });

    expect(refused).toMatchObject({ outcome: "refused", reason: `${id} is assigned to crystal` });
    expect(decided).toMatchObject({ outcome: "decided", replayed: false });
    expect(await approval(id)).toMatchObject({ status: "approved", decided_by: "tg:777" });
  });
});
