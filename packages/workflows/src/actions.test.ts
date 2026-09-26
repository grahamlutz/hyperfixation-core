import { checkE002, createStepPool, type StepPool } from "@hyperfixation/db";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actions,
  ActionUncertain,
  idempotencyKey,
  stubChannel,
  type ActionChannel,
} from "./actions.js";
import type { StepContext } from "./step.js";

interface ActionLogRow {
  id: string;
  status: string;
  workflow_id: string;
  idempotency_key: string;
  external_id: string | null;
}

interface TaskRow {
  id: string;
  record_type: string | null;
  record_id: string | null;
  title: string;
  origin: string;
  origin_ref: string;
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
        "SELECT id::text AS id, status, workflow_id, idempotency_key, external_id " +
          "FROM hf_action_log WHERE run_id = $1",
        [runId],
      );
      return rows[0];
    });
  }

  async function tasksOf(actionLogId: string): Promise<TaskRow[]> {
    return asRole(database.applicationUrl, async (pg) => {
      const { rows } = await pg.query<TaskRow>(
        "SELECT id::text AS id, record_type, record_id, title, origin, origin_ref " +
          "FROM hf_task WHERE origin_ref = $1 ORDER BY id",
        [actionLogId],
      );
      return rows;
    });
  }

  async function activitiesOf(runId: string): Promise<Record<string, unknown>[]> {
    return asRole(database.applicationUrl, async (pg) => {
      const { rows } = await pg.query(
        "SELECT record_type, record_id, kind, meta FROM hf_activity WHERE run_id = $1 ORDER BY id",
        [runId],
      );
      return rows;
    });
  }

  function countingChannel(
    dedupes = true,
    dedupeWindowMs?: number,
  ): ActionChannel & { sends: number } {
    const stub = stubChannel("counting");
    const channel = {
      name: stub.name,
      dedupes,
      ...(dedupeWindowMs === undefined ? {} : { dedupeWindowMs }),
      sends: 0,
      send: (dispatch: Parameters<ActionChannel["send"]>[0]) => {
        channel.sends += 1;
        return stub.send(dispatch);
      },
    };
    return channel;
  }

  /** The row a dead attempt leaves behind, in whichever of the two unknown statuses. */
  async function plantRow(runId: string, status: "started" | "failed"): Promise<void> {
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query(
        `INSERT INTO hf_action_log
           (run_id, key, workflow_id, channel, idempotency_key, status)
         VALUES ($1, 'send', $2, 'counting', $3, $4)`,
        [runId, `${runId}:9`, idempotencyKey(runId, "send"), status],
      );
    });
  }

  /** Backdates the first attempt, which is what the dedupe window is measured from. */
  async function ageRow(runId: string, interval: string): Promise<void> {
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query(
        `UPDATE hf_action_log SET started_at = now() - $2::interval WHERE run_id = $1`,
        [runId, interval],
      );
    });
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
    const channel = countingChannel(true);
    await plantRow("action-crashed", "started");

    await actions.perform(ctx, { key: ctx.key, channel });

    expect(channel.sends).toBe(1);
    expect(await rowOf("action-crashed")).toMatchObject({
      status: "ok",
      workflow_id: "action-crashed",
      idempotency_key: idempotencyKey("action-crashed", "send"),
    });
  });

  it("re-sends inside the provider's window, under the row's original key", async () => {
    const ctx = await context("action-inside-window", "send");
    const channel = countingChannel(true, 24 * 60 * 60 * 1000);
    await plantRow("action-inside-window", "started");
    await ageRow("action-inside-window", "1 hour");

    // The stub echoes the key it was dispatched with, so this asserts the provider is re-sent the
    // *same* key — which is the only reason a second send is at most one delivery.
    await expect(actions.perform(ctx, { key: ctx.key, channel })).resolves.toMatchObject({
      externalId: idempotencyKey("action-inside-window", "send"),
    });

    expect(channel.sends).toBe(1);
    expect(await rowOf("action-inside-window")).toMatchObject({
      status: "ok",
      idempotency_key: idempotencyKey("action-inside-window", "send"),
    });
  });

  it("asks a human rather than re-sending once the provider's window has run out", async () => {
    const ctx = await context("action-past-window", "send");
    const channel = countingChannel(true, 24 * 60 * 60 * 1000);
    await plantRow("action-past-window", "started");
    await ageRow("action-past-window", "48 hours");

    // `dedupes: true` is worth nothing here: the provider has forgotten the key, so a re-send is a
    // second delivery — a second physical letter, on the channel this window was added for.
    await expect(actions.perform(ctx, { key: ctx.key, channel })).rejects.toThrow(ActionUncertain);

    expect(channel.sends).toBe(0);
    const row = (await rowOf("action-past-window"))!;
    expect(row.status).toBe("uncertain");
    expect(await tasksOf(row.id)).toMatchObject([{ origin: "flow", origin_ref: row.id }]);
  });

  it("re-sends past any window on a channel that declares none", async () => {
    const ctx = await context("action-no-window", "send");
    const channel = countingChannel(true);
    await plantRow("action-no-window", "started");
    await ageRow("action-no-window", "30 days");

    await actions.perform(ctx, { key: ctx.key, channel });

    expect(channel.sends).toBe(1);
    expect(await rowOf("action-no-window")).toMatchObject({ status: "ok" });
  });

  it("asks a human rather than re-sending when the re-entered channel cannot dedupe", async () => {
    const ctx = await context("action-uncertain", "send");
    const channel = countingChannel(false);
    await plantRow("action-uncertain", "started");

    await expect(actions.perform(ctx, { key: ctx.key, channel })).rejects.toThrow(ActionUncertain);

    expect(channel.sends).toBe(0);
    const row = (await rowOf("action-uncertain"))!;
    expect(row.status).toBe("uncertain");
    expect(await tasksOf(row.id)).toEqual([
      {
        id: expect.any(String),
        // Null, not a stand-in record type: E002 would fail on one at the next boot.
        record_type: null,
        record_id: null,
        title: "Confirm counting send send for run action-uncertain",
        origin: "flow",
        origin_ref: row.id,
      },
    ]);
    const activities = await activitiesOf("action-uncertain");
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      kind: "action.uncertain",
      record_type: null,
      record_id: null,
      meta: { actionLogId: Number(row.id), key: "send", channel: "counting" },
    });
    // `business` is registered because another case in this file puts it on its own rows, and the
    // database is shared across the file: an empty registry made this assertion depend on running
    // before that case, which only held for some shuffle seeds. What it is actually about is that
    // the row *this* case wrote carries a NULL rather than a type nobody registered.
    await expect(
      asRole(database.applicationUrl, (pg) =>
        checkE002(pg, [{ table: "business", recordType: "business" }]),
      ),
    ).resolves.toBeUndefined();

    // A retry of the step reports the same thing and never opens a second task.
    await expect(actions.perform(ctx, { key: ctx.key, channel })).rejects.toThrow(ActionUncertain);
    expect(channel.sends).toBe(0);
    expect(await tasksOf(row.id)).toHaveLength(1);
    expect(await activitiesOf("action-uncertain")).toHaveLength(1);
  });

  it("treats a failed row the same way — the channel may have thrown after delivering", async () => {
    const ctx = await context("action-uncertain-failed", "send");
    const channel = countingChannel(false);
    await plantRow("action-uncertain-failed", "failed");

    await expect(actions.perform(ctx, { key: ctx.key, channel })).rejects.toThrow(ActionUncertain);

    expect(channel.sends).toBe(0);
    const row = (await rowOf("action-uncertain-failed"))!;
    expect(row.status).toBe("uncertain");
    expect(await tasksOf(row.id)).toMatchObject([{ origin: "flow", origin_ref: row.id }]);
  });

  it("carries the action's own record onto the task when it has one", async () => {
    const ctx = await context("action-uncertain-record", "send");
    const channel = countingChannel(false);
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query(
        `INSERT INTO hf_action_log
           (run_id, key, workflow_id, channel, idempotency_key, status, record_type, record_id)
         VALUES ($1, 'send', $2, 'counting', $3, 'started', 'business', 'biz-7')`,
        [
          "action-uncertain-record",
          "action-uncertain-record:9",
          idempotencyKey("action-uncertain-record", "send"),
        ],
      );
    });

    await expect(actions.perform(ctx, { key: ctx.key, channel })).rejects.toThrow(ActionUncertain);

    const row = (await rowOf("action-uncertain-record"))!;
    expect(await tasksOf(row.id)).toMatchObject([
      { record_type: "business", record_id: "biz-7", origin: "flow" },
    ]);
  });

  it("leaves a sweep's task alone on a row the sweep already moved", async () => {
    const ctx = await context("action-swept", "send");
    const channel = countingChannel(false);
    await plantRow("action-swept", "started");
    const row = (await rowOf("action-swept"))!;
    await asRole(database.applicationUrl, async (pg) => {
      await pg.query("UPDATE hf_action_log SET status = 'uncertain' WHERE id = $1", [row.id]);
      await pg.query(
        "INSERT INTO hf_task (record_type, record_id, title, origin, origin_ref) " +
          "VALUES (NULL, NULL, 'swept', 'sweep', $1)",
        [row.id],
      );
    });

    await expect(actions.perform(ctx, { key: ctx.key, channel })).rejects.toThrow(ActionUncertain);

    expect(channel.sends).toBe(0);
    expect(await tasksOf(row.id)).toMatchObject([{ origin: "sweep", title: "swept" }]);
    expect(await activitiesOf("action-swept")).toHaveLength(0);
  });

  it("sends a first dispatch even on a channel that cannot dedupe", async () => {
    const ctx = await context("action-first-send", "send");
    const channel = countingChannel(false);

    await expect(actions.perform(ctx, { key: ctx.key, channel })).resolves.toMatchObject({
      externalId: "action-first-send:send",
    });
    expect(channel.sends).toBe(1);
    expect(await rowOf("action-first-send")).toMatchObject({ status: "ok" });
  });

  it("records a failed dispatch and rethrows", async () => {
    const ctx = await context("action-failed", "send");
    const channel: ActionChannel = {
      name: "exploding",
      dedupes: true,
      send: () => Promise.reject(new Error("channel exploded")),
    };

    await expect(actions.perform(ctx, { key: ctx.key, channel })).rejects.toThrow(
      "channel exploded",
    );
    expect(await rowOf("action-failed")).toMatchObject({ status: "failed" });
  });

  it("hands a typed channel its own request shape, uncast", async () => {
    const ctx = await context("action-typed", "send");
    const seen: string[] = [];
    const channel: ActionChannel<{ to: string }> = {
      name: "typed",
      dedupes: true,
      send: (dispatch) => {
        // The point of the generic: `dispatch.request.to` without a cast in the channel body.
        seen.push(dispatch.request.to);
        return Promise.resolve({ externalId: dispatch.idempotencyKey });
      },
    };

    await actions.perform(ctx, { key: ctx.key, channel, request: { to: "crystal@example.com" } });

    expect(seen).toEqual(["crystal@example.com"]);
    expect(await rowOf("action-typed")).toMatchObject({ status: "ok" });
  });
});
