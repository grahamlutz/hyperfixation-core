import { createStepPool, type StepPool } from "@hyperfixation/db";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actions, idempotencyKey, stubChannel, type ActionChannel } from "./actions.js";
import type { StepContext } from "./step.js";

interface ActionLogRow {
  status: string;
  workflow_id: string;
  idempotency_key: string;
  external_id: string | null;
}

describe("actions.perform", () => {
  let database: TestDatabase;
  let steps: StepPool;

  beforeAll(async () => {
    database = await createTestDatabase();
    steps = createStepPool({ connectionString: database.applicationUrl });
  }, 60_000);

  afterAll(async () => {
    await steps?.end();
    await database?.drop();
  });

  async function context(runId: string, key: string): Promise<StepContext> {
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
      workflowId: runId,
      key,
      tx: (work) => steps.tx(runId, runId, work),
    };
  }

  async function rowOf(runId: string): Promise<ActionLogRow | undefined> {
    return asRole(database.applicationUrl, async (pg) => {
      const { rows } = await pg.query<ActionLogRow>(
        "SELECT status, workflow_id, idempotency_key, external_id FROM hf_action_log WHERE run_id = $1",
        [runId],
      );
      return rows[0];
    });
  }

  function countingChannel(): ActionChannel & { sends: number } {
    const stub = stubChannel("counting");
    const channel = {
      name: stub.name,
      sends: 0,
      send: (dispatch: Parameters<ActionChannel["send"]>[0]) => {
        channel.sends += 1;
        return stub.send(dispatch);
      },
    };
    return channel;
  }

  it("dispatches once and records the row, keyed by run and key", async () => {
    const ctx = await context("action-ok", "send");
    const channel = countingChannel();

    await expect(actions.perform(ctx, { key: ctx.key, channel })).resolves.toMatchObject({
      externalId: "action-ok:send",
    });
    expect(await rowOf("action-ok")).toMatchObject({
      status: "ok",
      idempotency_key: idempotencyKey("action-ok", "send"),
      external_id: "action-ok:send",
    });
    expect(channel.sends).toBe(1);
  });

  it("returns the recorded result on a replay without dispatching again", async () => {
    const ctx = await context("action-replay", "send");
    const channel = countingChannel();

    await actions.perform(ctx, { key: ctx.key, channel });
    await expect(actions.perform(ctx, { key: ctx.key, channel })).resolves.toMatchObject({
      externalId: "action-replay:send",
    });
    expect(channel.sends).toBe(1);
  });

  it("takes a started row left by a dead attempt back under this one", async () => {
    const ctx = await context("action-crashed", "send");
    const channel = countingChannel();
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query(
        `INSERT INTO hf_action_log
           (run_id, key, workflow_id, channel, idempotency_key, status)
         VALUES ('action-crashed', 'send', 'action-crashed:9', 'counting', $1, 'started')`,
        [idempotencyKey("action-crashed", "send")],
      );
    });

    await actions.perform(ctx, { key: ctx.key, channel });

    expect(channel.sends).toBe(1);
    expect(await rowOf("action-crashed")).toMatchObject({
      status: "ok",
      workflow_id: "action-crashed",
    });
  });

  it("records a failed dispatch and rethrows", async () => {
    const ctx = await context("action-failed", "send");
    const channel: ActionChannel = {
      name: "exploding",
      send: () => Promise.reject(new Error("channel exploded")),
    };

    await expect(actions.perform(ctx, { key: ctx.key, channel })).rejects.toThrow(
      "channel exploded",
    );
    expect(await rowOf("action-failed")).toMatchObject({ status: "failed" });
  });
});
