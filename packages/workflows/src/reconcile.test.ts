import { DBOS, type DBOSClient } from "@dbos-inc/dbos-sdk";
import { appPaused, ControlPlaneInWorkflow } from "@hyperfixation/db";
import { asRole, createTestDatabase, testBuildSha, type TestDatabase } from "@hyperfixation/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getClient, resetClient } from "./client.js";
import { createControlPool, type ControlPool } from "./control-pool.js";
import { defineFlow, type Flow } from "./define-flow.js";
import { setPausedQueueConcurrency } from "./queue-concurrency.js";
import {
  reconcile,
  sweepDecisionKey,
  RECONCILE_QUEUE_MARKER,
  type ReconcileReport,
} from "./reconcile.js";
import { runsStart } from "./runs.js";
import { QUEUES } from "./start-worker.js";

const THIS_VERSION = "version-b";
const DEAD_VERSION = "version-a";
const BUDGET_USD = "10.0000";

let database: TestDatabase;
let control: ControlPool;
let client: DBOSClient;
let flow: Flow<{ n: number }, void>;

/** Never dispatched: no worker launches in this file, so the body is only here to be named. */
function reconcileFlow(): Flow<{ n: number }, void> {
  return defineFlow<{ n: number }, void>("reconcileFlow", () => Promise.resolve(), {
    queue: "llm",
  });
}

async function query<R extends Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<R[]> {
  const { rows } = await control.pool.query<R>(sql, values);
  return rows;
}

/** Starts a run for real — `hf_run` row and `dbos.workflow_status` row in one transaction. */
async function startRun(runId: string): Promise<void> {
  await runsStart(control.pool, client, flow, { n: 1 }, { runId });
}

async function setWorkflow(
  workflowId: string,
  status: string,
  applicationVersion: string | null,
): Promise<void> {
  await query(
    "UPDATE dbos.workflow_status SET status = $2, application_version = $3 WHERE workflow_uuid = $1",
    [workflowId, status, applicationVersion],
  );
}

async function run(runId: string): Promise<Record<string, unknown> | undefined> {
  return (
    await query("SELECT status, attempt, current_workflow_id, error FROM hf_run WHERE run_id = $1", [
      runId,
    ])
  )[0];
}

async function workflow(workflowId: string): Promise<Record<string, unknown> | undefined> {
  return (
    await query("SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1", [workflowId])
  )[0];
}

async function insertLedgerRow(runId: string, key: string, workflowId: string): Promise<void> {
  await query(
    "INSERT INTO hf_llm_call (run_id, key, workflow_id, period, input_hash, status, " +
      "estimated_cost_usd) VALUES ($1, $2, $3, '2026-09', 'hash', 'started', 1.0)",
    [runId, key, workflowId],
  );
}

async function ledgerRow(runId: string): Promise<Record<string, unknown> | undefined> {
  return (
    await query("SELECT status, finished_at FROM hf_llm_call WHERE run_id = $1", [runId])
  )[0];
}

async function pass(): Promise<ReconcileReport> {
  return reconcile(control.pool, client, { applicationVersion: THIS_VERSION });
}

function runIdFor(name: string): string {
  return `${name}-${testBuildSha()}`;
}

beforeAll(async () => {
  database = await createTestDatabase();
  control = createControlPool({ connectionString: database.applicationUrl });
  client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
  flow = reconcileFlow();
  await asRole(database.migratorUrl, async (pg) => {
    await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, $1)", [
      BUDGET_USD,
    ]);
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
  await query("DELETE FROM hf_llm_call");
  await query("DELETE FROM hf_action_log");
  await query("DELETE FROM hf_run");
  await query("DELETE FROM hf_budget_period");
  await query("UPDATE hf_app_state SET paused = false WHERE id = 1");
});

describe("reconcile() step (1) — running runs", () => {
  it("cancels an attempt left under a dead version and bumps the run onto this one", async () => {
    const runId = runIdFor("dead");
    await startRun(runId);
    await setWorkflow(runId, "PENDING", DEAD_VERSION);

    const report = await pass();

    expect(report.reattempted).toEqual([
      { runId, attempt: 2, workflowId: `${runId}:2`, reason: "dead-version" },
    ]);
    expect(await run(runId)).toMatchObject({
      status: "running",
      attempt: 2,
      current_workflow_id: `${runId}:2`,
    });
    expect(await workflow(runId)).toMatchObject({ status: "CANCELLED" });
    // The bump and the enqueue are one transaction, so the new attempt exists as surely as the
    // fencing token that names it.
    expect(await workflow(`${runId}:2`)).toMatchObject({ status: "ENQUEUED" });
  });

  it("leaves an attempt running under this version alone", async () => {
    const runId = runIdFor("live");
    await startRun(runId);
    await setWorkflow(runId, "PENDING", THIS_VERSION);

    const report = await pass();

    expect(report.reattempted).toEqual([]);
    expect(await run(runId)).toMatchObject({ attempt: 1, current_workflow_id: runId });
  });

  it("never bumps an attempt it enqueued itself, however many passes run", async () => {
    const runId = runIdFor("own");
    await startRun(runId);
    await setWorkflow(runId, "PENDING", DEAD_VERSION);

    await pass();
    // A control-plane enqueue stamps no `application_version` — the state the first pass left
    // behind. Reading that as "not this version" would make every pass bump the backlog again.
    expect(await query("SELECT application_version FROM dbos.workflow_status WHERE workflow_uuid = $1", [`${runId}:2`])).toEqual([
      { application_version: null },
    ]);

    const second = await pass();
    const third = await pass();

    expect(second.reattempted).toEqual([]);
    expect(third.reattempted).toEqual([]);
    expect(await run(runId)).toMatchObject({ attempt: 2 });
  });

  it("marks a run whose workflow finished while the run was never marked", async () => {
    const done = runIdFor("succeeded");
    const failed = runIdFor("errored");
    await startRun(done);
    await startRun(failed);
    await setWorkflow(done, "SUCCESS", DEAD_VERSION);
    await setWorkflow(failed, "ERROR", DEAD_VERSION);

    const report = await pass();

    expect(report.concluded).toEqual(
      expect.arrayContaining([
        { runId: done, status: "done", dbosStatus: "SUCCESS" },
        { runId: failed, status: "failed", dbosStatus: "ERROR" },
      ]),
    );
    expect(report.concluded).toHaveLength(2);
    expect(await run(done)).toMatchObject({ status: "done", attempt: 1 });
    expect(await run(failed)).toMatchObject({ status: "failed", attempt: 1 });
    expect(report.reattempted).toEqual([]);
  });

  it("re-attempts a cancelled current attempt rather than failing the run", async () => {
    const runId = runIdFor("cancelled");
    await startRun(runId);
    await setWorkflow(runId, "CANCELLED", DEAD_VERSION);

    const report = await pass();

    // The state a pass that died between its own cancel and its own bump leaves behind. `failed`
    // is terminal, so concluding here would destroy work the cancel was only moving.
    expect(report.reattempted).toEqual([
      { runId, attempt: 2, workflowId: `${runId}:2`, reason: "cancelled" },
    ]);
    expect(await run(runId)).toMatchObject({ status: "running", attempt: 2 });
  });

  it("counts a run with no workflow row as an anomaly and enqueues it anyway", async () => {
    const runId = runIdFor("anomaly");
    await startRun(runId);
    await query("DELETE FROM dbos.workflow_status WHERE workflow_uuid = $1", [runId]);

    const report = await pass();

    expect(report.anomalies).toEqual([{ runId, workflowId: runId, enqueued: true }]);
    // The id was fresh, so what was missing is the enqueue, not the attempt.
    expect(await run(runId)).toMatchObject({ attempt: 1, current_workflow_id: runId });
    expect(await workflow(runId)).toMatchObject({ status: "ENQUEUED" });
    expect((await pass()).anomalies).toEqual([]);
  });
});

describe("reconcile() as a control-plane operation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses from inside a workflow, before any statement", async () => {
    vi.spyOn(DBOS, "isWithinWorkflow").mockReturnValue(true);
    const connect = vi.spyOn(control.pool, "connect");

    await expect(pass()).rejects.toBeInstanceOf(ControlPlaneInWorkflow);
    expect(connect).not.toHaveBeenCalled();
  });

  it("rolls a refused run's bump back and reconciles the rest of the pass anyway", async () => {
    const orphan = runIdFor("unknown-flow");
    const sound = runIdFor("alongside");
    await startRun(orphan);
    await startRun(sound);
    // The flow the app registered under this name is gone from this deploy. Its next attempt
    // has no queue to be enqueued on, so the bump must not commit either.
    await query("UPDATE hf_run SET flow = 'retiredFlow' WHERE run_id = $1", [orphan]);
    await setWorkflow(orphan, "PENDING", DEAD_VERSION);
    await setWorkflow(sound, "PENDING", DEAD_VERSION);

    const report = await pass();

    expect(report.failures).toEqual([
      { runId: orphan, step: "reattempt", error: expect.stringContaining("UnknownFlow") },
    ]);
    // The fencing token never moved, so the run is still exactly what the next pass will find.
    expect(await run(orphan)).toMatchObject({ attempt: 1, current_workflow_id: orphan });
    expect(await workflow(`${orphan}:2`)).toBeUndefined();

    expect(report.reattempted).toEqual([
      { runId: sound, attempt: 2, workflowId: `${sound}:2`, reason: "dead-version" },
    ]);
  });
});

describe("reconcile() step (3) — paused runs", () => {
  it("starts the next attempt of a paused run once the app is no longer paused", async () => {
    const runId = runIdFor("paused");
    await startRun(runId);
    await query("UPDATE hf_run SET status = 'paused' WHERE run_id = $1", [runId]);

    const report = await pass();

    expect(report.reattempted).toEqual([
      { runId, attempt: 2, workflowId: `${runId}:2`, reason: "resumed" },
    ]);
    expect(await run(runId)).toMatchObject({ status: "running", attempt: 2 });
  });

  it("leaves paused runs alone while the app is paused", async () => {
    const runId = runIdFor("still-paused");
    await startRun(runId);
    await query("UPDATE hf_run SET status = 'paused' WHERE run_id = $1", [runId]);
    await query("UPDATE hf_app_state SET paused = true WHERE id = 1");

    expect((await pass()).reattempted).toEqual([]);
    expect(await run(runId)).toMatchObject({ status: "paused", attempt: 1 });
  });
});

describe("reconcile() step (4) — ledger hygiene", () => {
  it("abandons started rows nothing can still be in flight for, and only those", async () => {
    const failed = runIdFor("hygiene-failed");
    const waiting = runIdFor("hygiene-waiting");
    const stale = runIdFor("hygiene-stale");
    const live = runIdFor("hygiene-live");
    for (const runId of [failed, waiting, stale, live]) await startRun(runId);
    await query("UPDATE hf_run SET status = 'failed' WHERE run_id = $1", [failed]);
    await query("UPDATE hf_run SET status = 'waiting' WHERE run_id = $1", [waiting]);
    // Round 3's widening: a `running` run's row written by an attempt that is no longer current.
    await query("UPDATE hf_run SET attempt = 2, current_workflow_id = $2 WHERE run_id = $1", [
      stale,
      `${stale}:2`,
    ]);
    await setWorkflow(live, "PENDING", THIS_VERSION);

    await insertLedgerRow(failed, "x", failed);
    await insertLedgerRow(waiting, "x", waiting);
    await insertLedgerRow(stale, "x", stale);
    await insertLedgerRow(live, "x", live);

    const report = await pass();

    expect(report.abandonedLlmCalls).toBe(3);
    expect(await ledgerRow(failed)).toMatchObject({ status: "abandoned" });
    expect(await ledgerRow(waiting)).toMatchObject({ status: "abandoned" });
    expect(await ledgerRow(stale)).toMatchObject({ status: "abandoned" });
    // The one row a live attempt can still complete, and the one that still reserves budget.
    expect(await ledgerRow(live)).toMatchObject({ status: "started", finished_at: null });
  });

  it("transitions an orphaned row exactly once across three passes", async () => {
    const runId = runIdFor("idempotent");
    await startRun(runId);
    await query("UPDATE hf_run SET status = 'failed' WHERE run_id = $1", [runId]);
    await insertLedgerRow(runId, "x", runId);

    const first = await pass();
    const abandoned = await ledgerRow(runId);
    const second = await pass();
    const third = await pass();

    expect([first.abandonedLlmCalls, second.abandonedLlmCalls, third.abandonedLlmCalls]).toEqual([
      1, 0, 0,
    ]);
    expect(await ledgerRow(runId)).toEqual(abandoned);
  });

  it("moves an orphaned action row to uncertain, the status that already means this", async () => {
    const runId = runIdFor("action");
    await startRun(runId);
    await query("UPDATE hf_run SET status = 'failed' WHERE run_id = $1", [runId]);
    await query(
      "INSERT INTO hf_action_log (run_id, key, workflow_id, channel, idempotency_key, status) " +
        "VALUES ($1, 'send', $1, 'stub', $2, 'started')",
      [runId, `${runId}:send`],
    );

    expect((await pass()).uncertainActions).toBe(1);
    expect(
      await query("SELECT status FROM hf_action_log WHERE run_id = $1", [runId]),
    ).toEqual([{ status: "uncertain" }]);
    expect((await pass()).uncertainActions).toBe(0);
  });
});

describe("reconcile() step (5) — expiring pending approvals", () => {
  /** `expiresAt` is a SQL expression rather than a value, so a deadline can be relative to now. */
  async function insertApproval(
    runId: string,
    expiresAt: string,
    status = "pending",
  ): Promise<number> {
    const rows = await query<{ id: string }>(
      "INSERT INTO hf_approval (run_id, key, workflow_id, type, status, expires_at) " +
        `VALUES ($1, 'send', $1, 'send-email', $2, ${expiresAt}) RETURNING id`,
      [runId, status],
    );
    return Number(rows[0]!.id);
  }

  async function approval(id: number): Promise<Record<string, unknown> | undefined> {
    return (
      await query(
        "SELECT status, decided_via, decision_key, decided_at, resume_workflow_id " +
          "FROM hf_approval WHERE id = $1",
        [id],
      )
    )[0];
  }

  it("decides an expired row via the sweep and bumps its run onto the resume attempt", async () => {
    const runId = runIdFor("expired");
    await startRun(runId);
    await query("UPDATE hf_run SET status = 'waiting' WHERE run_id = $1", [runId]);
    const id = await insertApproval(runId, "now() - interval '1 minute'");

    const report = await pass();

    expect(report.expired).toEqual([{ approvalId: id, runId, workflowId: `${runId}:2` }]);
    expect(await approval(id)).toMatchObject({
      status: "expired",
      decided_via: "sweep",
      decision_key: sweepDecisionKey(id),
      resume_workflow_id: `${runId}:2`,
    });
    // The expiry is a decision like any other, so the run resumes to learn about it.
    expect(await run(runId)).toMatchObject({
      status: "running",
      attempt: 2,
      current_workflow_id: `${runId}:2`,
    });
    expect(await workflow(`${runId}:2`)).toMatchObject({ status: "ENQUEUED" });
  });

  it("leaves a row with no deadline, one still inside it, and one already decided alone", async () => {
    const open = runIdFor("open");
    const future = runIdFor("future");
    const decided = runIdFor("decided");
    for (const runId of [open, future, decided]) {
      await startRun(runId);
      await query("UPDATE hf_run SET status = 'waiting' WHERE run_id = $1", [runId]);
    }
    const ids = [
      await insertApproval(open, "NULL"),
      await insertApproval(future, "now() + interval '1 hour'"),
      await insertApproval(decided, "now() - interval '1 minute'", "approved"),
    ];

    const report = await pass();

    expect(report.expired).toEqual([]);
    for (const runId of [open, future, decided]) {
      expect(await run(runId)).toMatchObject({ attempt: 1, status: "waiting" });
    }
    expect(ids).toHaveLength(3);
  });

  it("expires a row once however many passes run", async () => {
    const runId = runIdFor("sweep-idempotent");
    await startRun(runId);
    await query("UPDATE hf_run SET status = 'waiting' WHERE run_id = $1", [runId]);
    const id = await insertApproval(runId, "now() - interval '1 minute'");

    const first = await pass();
    const expired = await approval(id);
    const second = await pass();

    expect([first.expired.length, second.expired.length]).toEqual([1, 0]);
    expect(await approval(id)).toEqual(expired);
    expect(await run(runId)).toMatchObject({ attempt: 2 });
  });

  it("carries on with the rest of the pass when one expiry is refused", async () => {
    const orphan = runIdFor("orphan");
    const good = runIdFor("good-after-orphan");
    await startRun(good);
    await query("UPDATE hf_run SET status = 'waiting' WHERE run_id = $1", [good]);
    // An approval whose run was deleted from under it: `decide()`'s bump throws RunNotFound.
    const orphaned = await insertApproval(orphan, "now() - interval '1 minute'");
    const sound = await insertApproval(good, "now() - interval '1 minute'");

    const report = await pass();

    expect(report.expired).toEqual([{ approvalId: sound, runId: good, workflowId: `${good}:2` }]);
    expect(report.failures).toEqual([
      { runId: orphan, step: "expire", error: expect.stringContaining("RunNotFound") },
    ]);
    expect(await approval(orphaned)).toMatchObject({ status: "pending" });
  });
});

describe("reconcile()'s drift read", () => {
  it("reports per-period drift and never corrects it", async () => {
    await query(
      "INSERT INTO hf_budget_period (period, budget_usd, spent_usd) VALUES ('2026-09', 10, 3)",
    );
    const runId = runIdFor("drift");
    await startRun(runId);
    await query(
      "INSERT INTO hf_llm_call (run_id, key, workflow_id, period, input_hash, status, " +
        "estimated_cost_usd, cost_usd) VALUES ($1, 'x', $1, '2026-09', 'hash', 'ok', 1.0, 2.5)",
      [runId],
    );

    const report = await pass();

    expect(report.drift).toEqual([
      { period: "2026-09", spentUsd: "3.0000", ledgerUsd: "2.500000", driftUsd: "0.500000" },
    ]);
    expect(
      await query("SELECT spent_usd FROM hf_budget_period WHERE period = '2026-09'"),
    ).toEqual([{ spent_usd: "3.0000" }]);
  });

  it("completes a pass while another transaction holds the period row", async () => {
    await query(
      "INSERT INTO hf_budget_period (period, budget_usd, spent_usd) VALUES ('2026-09', 10, 3)",
    );
    const holder = await control.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM hf_budget_period WHERE period = '2026-09' FOR UPDATE");

      // A one-second `lock_timeout`: if any statement of the pass waited on the budget row it
      // would fail with 55P03 rather than return. `reconcile()` never locks one.
      const report = await reconcile(control.pool, client, {
        applicationVersion: THIS_VERSION,
        lockTimeout: "1s",
      });

      expect(report.drift).toHaveLength(1);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }, 30_000);
});

describe("reconcile() step (6) — queue concurrency against the pause flag", () => {
  /** The rows a launched worker's `registerQueue` calls would have written. */
  beforeAll(async () => {
    for (const queue of QUEUES) {
      await client.registerQueue(queue.name, { globalConcurrency: queue.globalConcurrency });
    }
  }, 30_000);

  beforeEach(async () => {
    await setPausedQueueConcurrency(client, false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function queueConcurrency(): Promise<Record<string, number | null>> {
    const rows = await query<{ name: string; concurrency: number | null }>(
      "SELECT name, concurrency FROM dbos.queues ORDER BY name",
    );
    return Object.fromEntries(rows.map((row) => [row.name, row.concurrency]));
  }

  /**
   * Chunk 13's race, in its order and through the real functions: worker B reads `paused`, the
   * admin's resume clears the flag and restores the queues, and worker B's zeroing lands after
   * it. Nothing here is timing-dependent — the interleaving is written out.
   */
  async function raceResumeAgainstABootingWorker(): Promise<void> {
    await query("UPDATE hf_app_state SET paused = true WHERE id = 1");
    await setPausedQueueConcurrency(client, true);

    const workerRead = await appPaused(control.pool);

    await query("UPDATE hf_app_state SET paused = false WHERE id = 1");
    await setPausedQueueConcurrency(client, false);

    if (workerRead) await setPausedQueueConcurrency(client, true);
  }

  it("restores the queues a resume lost to a booting worker's stale read", async () => {
    await raceResumeAgainstABootingWorker();
    expect(await queueConcurrency()).toEqual({ actions: 0, llm: 0, resolve: 1 });

    const info = vi.spyOn(console, "info");
    const report = await pass();

    expect(report.queueConcurrency).toEqual([
      { name: "llm", paused: false, was: 0, now: 4 },
      { name: "actions", paused: false, was: 0, now: 2 },
    ]);
    // `resolve` is not a queue `pause` touches, so it is not a queue this step touches either.
    expect(await queueConcurrency()).toEqual({ actions: 2, llm: 4, resolve: 1 });
    // Both concurrencies on the line: which direction a pass went is the whole diagnosis.
    expect(info).toHaveBeenCalledWith(
      RECONCILE_QUEUE_MARKER,
      JSON.stringify({ name: "llm", paused: false, was: 0, now: 4 }),
    );
  });

  it("zeroes a queue still dispatching under a paused app", async () => {
    // The mirror: a pause whose queue half never landed, which is a "paused" app still
    // reaching the outside world.
    await query("UPDATE hf_app_state SET paused = true WHERE id = 1");
    expect(await queueConcurrency()).toEqual({ actions: 2, llm: 4, resolve: 1 });

    const report = await pass();

    expect(report.queueConcurrency).toEqual([
      { name: "llm", paused: true, was: 4, now: 0 },
      { name: "actions", paused: true, was: 2, now: 0 },
    ]);
    expect(await queueConcurrency()).toEqual({ actions: 0, llm: 0, resolve: 1 });
  });

  it("leaves an agreeing state alone, paused or not, however many passes run", async () => {
    expect((await pass()).queueConcurrency).toEqual([]);
    expect((await pass()).queueConcurrency).toEqual([]);
    expect(await queueConcurrency()).toEqual({ actions: 2, llm: 4, resolve: 1 });

    await query("UPDATE hf_app_state SET paused = true WHERE id = 1");
    await setPausedQueueConcurrency(client, true);

    expect((await pass()).queueConcurrency).toEqual([]);
    expect((await pass()).queueConcurrency).toEqual([]);
    expect(await queueConcurrency()).toEqual({ actions: 0, llm: 0, resolve: 1 });
  });

  it("corrects a stuck queue once, and the pass after it has nothing to do", async () => {
    await raceResumeAgainstABootingWorker();

    const first = await pass();
    const second = await pass();

    expect(first.queueConcurrency).toHaveLength(2);
    expect(second.queueConcurrency).toEqual([]);
    expect(await queueConcurrency()).toEqual({ actions: 2, llm: 4, resolve: 1 });
  });

  it("leaves a concurrency somebody tuned to a non-zero value alone", async () => {
    // Only the two disagreements the race produces are corrected; a queue running at 1 under an
    // unpaused app is an operator's, and a pass that overwrote it every minute would be worse
    // than the stall it fixes.
    const llm = (await client.retrieveQueue("llm"))!;
    await llm.setGlobalConcurrency(1);

    expect((await pass()).queueConcurrency).toEqual([]);
    expect(await queueConcurrency()).toMatchObject({ llm: 1 });
  });
});
