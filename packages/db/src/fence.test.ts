import { EventEmitter } from "node:events";
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bumpAttempt,
  CommitLost,
  ConcurrentBump,
  ControlPlaneInWorkflow,
  controlPlaneTx,
  RunLockTimeout,
  WorkflowIdCollision,
  type BumpedAttempt,
} from "./control-plane.js";
import { UnfencedWrite, unfencedWriteOf } from "./fenced-client.js";
import { migrate } from "./migrate.js";
import { createStepPool, StaleAttempt, type StepDatabase, type StepPool } from "./step-pool.js";
import { asRole, createTestDatabase, type TestDatabase } from "./test-support/database.js";
import { countRuns, stampVersion } from "./test-support/sibling-helper.js";

const RUN_ID = "fence-run";
const WORKFLOW_ID = "fence-run";
const READ = "SELECT 1";

/** The queue and flow the bumped attempt would be enqueued on; chunk 9 sources both from the registry. */
const QUEUE = "llm";
const FLOW = "demoFlow";

const writeSql = (marker: string) =>
  `UPDATE hf_run SET version = '${marker}' WHERE run_id = '${RUN_ID}'`;

let database: TestDatabase;
let step: StepPool;
let control: Pool;
let dbos: DBOSClient;

/** Reads the marker outside the fence entirely, so it is evidence and not another subject. */
async function version(): Promise<string | null> {
  return asRole(database.applicationUrl, async (client) => {
    const { rows } = await client.query<{ version: string | null }>(
      "SELECT version FROM hf_run WHERE run_id = $1",
      [RUN_ID],
    );
    return rows[0]!.version;
  });
}

/** Settles `work` and asserts it was refused, unwrapping Drizzle's `DrizzleQueryError`. */
async function expectRefused(work: Promise<unknown>): Promise<UnfencedWrite> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  const refusal = unfencedWriteOf(error);
  expect(refusal).toBeInstanceOf(UnfencedWrite);
  return refusal!;
}

/** The positive half of every case: the same statement, inside a real `ctx.tx`. */
async function insideCtxTx(marker: string): Promise<void> {
  await step.tx(RUN_ID, WORKFLOW_ID, async (tx) => {
    await tx.execute(sql.raw(writeSql(marker)));
  });
  expect(await version()).toBe(marker);
}

/** A write on a connection checked out of the step pool by hand. */
async function writeOnCheckedOutClient(marker: string): Promise<void> {
  const client = await step.pool.connect();
  try {
    await client.query(writeSql(marker));
  } finally {
    client.release();
  }
}

async function readOnCheckedOutClient(): Promise<number> {
  const client = await step.pool.connect();
  try {
    const { rows } = await client.query<{ one: number }>(`${READ} AS one`);
    return rows[0]!.one;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.migratorUrl, { appName: database.appName });
  await asRole(database.applicationUrl, async (client) => {
    await client.query(
      `INSERT INTO hf_run (run_id, flow, status, attempt, current_workflow_id)
       VALUES ($1, 'demo', 'running', 1, $2)`,
      [RUN_ID, WORKFLOW_ID],
    );
  });
  step = createStepPool({ connectionString: database.applicationUrl });
  // The control pool as `startWorker()` builds it: two connections, no fence. Built from `pg`
  // here rather than through `createControlPool`, which lives behind `src/internal` and is
  // therefore out of reach of every module the exports map publishes — this file included.
  control = new Pool({ connectionString: database.applicationUrl, max: 2 });
  dbos = await DBOSClient.create({
    systemDatabaseUrl: database.applicationUrl,
    systemDatabaseSchemaName: "dbos",
  });
}, 60_000);

afterAll(async () => {
  await dbos?.destroy();
  await control?.end();
  await step?.end();
  await database?.drop();
});

beforeEach(async () => {
  await asRole(database.applicationUrl, async (client) => {
    await client.query("UPDATE hf_run SET version = NULL WHERE run_id = $1", [RUN_ID]);
  });
});

describe("fence.test.ts case (vi) — the six escape shapes", () => {
  describe("(a) a module-level setInterval draining a queue filled inside a step", () => {
    const pending: Array<() => Promise<unknown>> = [];

    /** The interval is the escape: its callback runs on no `ctx.tx`'s connection. */
    function drainOnce(): Promise<unknown> {
      return new Promise((resolve) => {
        const timer = setInterval(() => {
          const job = pending.shift();
          if (!job) return;
          clearInterval(timer);
          resolve(job().then(() => "ok", (error: unknown) => error));
        }, 5);
      });
    }

    it("refuses the write the interval flushes", async () => {
      const drained = drainOnce();
      await step.tx(RUN_ID, WORKFLOW_ID, async () => {
        pending.push(() => writeOnCheckedOutClient("a"));
      });

      expect(await drained).toBeInstanceOf(UnfencedWrite);
      expect(await version()).toBeNull();
    });

    it("lets the interval's SELECT through", async () => {
      const drained = drainOnce();
      await step.tx(RUN_ID, WORKFLOW_ID, async () => {
        pending.push(() => readOnCheckedOutClient());
      });

      expect(await drained).toBe("ok");
    });

    it("commits the same write inside ctx.tx", async () => {
      await insideCtxTx("a-inside");
    });
  });

  describe("(b) an EventEmitter listener registered inside a step, fired from a timer outside", () => {
    const bus = new EventEmitter();

    async function listenInsideStepThenFire(job: () => Promise<unknown>): Promise<unknown> {
      let settled!: Promise<unknown>;
      await step.tx(RUN_ID, WORKFLOW_ID, async () => {
        bus.once("flush", () => {
          settled = job().then(
            () => "ok",
            (error: unknown) => error,
          );
        });
      });

      // Registered inside the step, triggered from a timer outside every ctx.tx.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      bus.emit("flush");
      return settled;
    }

    it("refuses the listener's write", async () => {
      expect(await listenInsideStepThenFire(() => writeOnCheckedOutClient("b"))).toBeInstanceOf(
        UnfencedWrite,
      );
      expect(await version()).toBeNull();
    });

    it("lets the listener's SELECT through", async () => {
      expect(await listenInsideStepThenFire(() => readOnCheckedOutClient())).toBe("ok");
    });

    it("commits the same write inside ctx.tx", async () => {
      await insideCtxTx("b-inside");
    });
  });

  describe("(c) a flow body writing before its first step", () => {
    async function flowBody(marker: string, fenced: boolean): Promise<void> {
      if (!fenced) {
        await step.db.execute(sql.raw(writeSql(marker)));
        return;
      }
      await step.tx(RUN_ID, WORKFLOW_ID, async (tx) => {
        await tx.execute(sql.raw(writeSql(marker)));
      });
    }

    it("refuses the write", async () => {
      await expectRefused(flowBody("c", false));
      expect(await version()).toBeNull();
    });

    it("lets the body's SELECT through", async () => {
      await expect(step.db.execute(sql.raw(READ))).resolves.toBeDefined();
    });

    it("commits the same write once the body opens ctx.tx", async () => {
      await flowBody("c-inside", true);
      expect(await version()).toBe("c-inside");
    });
  });

  describe("(d) a helper in a sibling directory, same import path either side", () => {
    it("refuses the helper's write when it is handed the pool", async () => {
      await expectRefused(stampVersion(step.db, RUN_ID, "d"));
      expect(await version()).toBeNull();
    });

    it("lets the helper's SELECT through when it is handed the pool", async () => {
      await expect(countRuns(step.db)).resolves.toBe(1);
    });

    it("commits the helper's write when it is handed the ctx.tx handle", async () => {
      await step.tx(RUN_ID, WORKFLOW_ID, async (tx) => {
        await stampVersion(tx, RUN_ID, "d-inside");
      });
      expect(await version()).toBe("d-inside");
    });
  });

  describe("(e) drizzle's own db.transaction on the step pool", () => {
    /**
     * Drizzle's own `db.transaction()` checks a client out and issues `BEGIN` before opening
     * the try/finally that would release it, so a refusal here would leak the checkout if the
     * fence didn't release proactively (see `fenceClient`'s `query`) — no workaround needed.
     */
    function transactionOnPool(work: (tx: StepDatabase) => Promise<unknown>) {
      return step.db.transaction(work as never);
    }

    it("refuses the BEGIN, so the transaction never opens", async () => {
      const refusal = await expectRefused(
        transactionOnPool(async (tx) => tx.execute(sql.raw(writeSql("e")))),
      );

      expect(refusal.statement.toLowerCase()).toBe("begin");
      expect(await version()).toBeNull();
    });

    it("refuses a read-only transaction too, and lets the same SELECT through untransacted", async () => {
      await expectRefused(transactionOnPool(async (tx) => tx.execute(sql.raw(READ))));
      await expect(step.db.execute(sql.raw(READ))).resolves.toBeDefined();
    });

    it("commits the same write inside ctx.tx, the one sanctioned transaction", async () => {
      await insideCtxTx("e-inside");
    });

    it("does not leak the checkout: refusing db.transaction() many times over never exhausts the pool", async () => {
      const solo = createStepPool({ connectionString: database.applicationUrl, max: 1 });
      try {
        for (let i = 0; i < 5; i++) {
          await expectRefused(
            solo.db.transaction(async (tx) => (tx as StepDatabase).execute(sql.raw(READ + " -- e-repeat"))),
          );
        }
        // If any earlier refusal had leaked its checkout, a max:1 pool would hang here.
        await expect(
          Promise.race([
            solo.pool.query(READ),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 2_000)),
          ]),
        ).resolves.toBeDefined();
      } finally {
        await solo.end();
      }
    });
  });

  describe("(f) a handle captured inside ctx.tx and used after the commit", () => {
    it("refuses the captured handle's write once the transaction has committed", async () => {
      let captured!: StepDatabase;
      await step.tx(RUN_ID, WORKFLOW_ID, async (tx) => {
        captured = tx;
      });

      await expectRefused(captured.execute(sql.raw(writeSql("f"))));
      expect(await version()).toBeNull();
    });

    it("lets the captured handle's SELECT through", async () => {
      let captured!: StepDatabase;
      await step.tx(RUN_ID, WORKFLOW_ID, async (tx) => {
        captured = tx;
      });

      await expect(captured.execute(sql.raw(READ))).resolves.toBeDefined();
    });

    it("stays refused when the pool re-leases that same connection to another ctx.tx", async () => {
      // max 1 makes the reuse certain rather than likely: the second transaction is
      // guaranteed the connection the first one captured.
      const solo = createStepPool({ connectionString: database.applicationUrl, max: 1 });
      try {
        let captured!: StepDatabase;
        let firstPid = 0;
        await solo.tx(RUN_ID, WORKFLOW_ID, async (tx) => {
          captured = tx;
          firstPid = await backendPid(tx);
        });

        await solo.tx(RUN_ID, WORKFLOW_ID, async (tx) => {
          expect(await backendPid(tx)).toBe(firstPid);
          await expectRefused(captured.execute(sql.raw(writeSql("f-reused"))));
        });

        expect(await version()).toBeNull();
      } finally {
        await solo.end();
      }
    });

    it("commits the same write inside ctx.tx", async () => {
      await insideCtxTx("f-inside");
    });
  });
});

describe("ctx.tx", () => {
  it("throws StaleAttempt and runs no work when the fencing token has moved on", async () => {
    let ran = false;
    await expect(
      step.tx(RUN_ID, "fence-run:2", async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(StaleAttempt);

    expect(ran).toBe(false);
  });

  it("rolls the write back when work throws", async () => {
    await expect(
      step.tx(RUN_ID, WORKFLOW_ID, async (tx) => {
        await tx.execute(sql.raw(writeSql("rolled-back")));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await version()).toBeNull();
  });

  it("untags the connection even when work throws", async () => {
    let captured!: StepDatabase;
    await expect(
      step.tx(RUN_ID, WORKFLOW_ID, async (tx) => {
        captured = tx;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expectRefused(captured.execute(sql.raw(writeSql("after-throw"))));
  });
});

describe("fence.test.ts case (i) — a bump blocks on a held ctx.tx", () => {
  it("does not resolve until the held transaction commits", async () => {
    const runId = await createRun();
    const held = holdCtxTx(runId);
    await held.fenced;

    let resolvedAt = 0;
    const bump = bumpOnce(runId).then((bumped) => {
      resolvedAt = Date.now();
      return bumped;
    });

    await sleep(250);
    expect(resolvedAt).toBe(0);
    expect(await runRow(runId)).toMatchObject({ attempt: 1, current_workflow_id: runId });

    const releasedAt = Date.now();
    await held.release();
    const bumped = await bump;

    expect(resolvedAt).toBeGreaterThanOrEqual(releasedAt);
    expect(bumped).toMatchObject({ attempt: 2, workflowId: `${runId}:2` });
    expect(await runRow(runId)).toMatchObject({ attempt: 2, status: "running" });
  });
});

describe("fence.test.ts case (ii) — ctx.tx on the attempt the bump moved past", () => {
  it("throws StaleAttempt before any write", async () => {
    const runId = await createRun();
    await bumpOnce(runId);

    let ran = false;
    await expect(
      step.tx(runId, runId, async (tx) => {
        ran = true;
        await tx.execute(sql.raw(`UPDATE hf_run SET version = 'ii' WHERE run_id = '${runId}'`));
      }),
    ).rejects.toBeInstanceOf(StaleAttempt);

    expect(ran).toBe(false);
    expect(await runRow(runId)).toMatchObject({ version: null });
  });
});

describe("fence.test.ts case (iii) — the compare-and-set", () => {
  it("lets exactly one of two bumps that read the same attempt win", async () => {
    const runId = await createRun();

    const settled = await controlPlaneTx(control, { operation: "case-iii" }, (client) =>
      // Issued together on one connection so both reads land before either write. Every bump
      // holds `FOR UPDATE`, so a bump on a second connection would wait and then re-read the
      // bumped row — it would reach attempt 3, not the compare-and-set. `allSettled` swallows
      // nothing Postgres raised: a row count of 0 is an answer, not an error, so the
      // transaction is not aborted and the commit below is a real one.
      Promise.allSettled([bumpAttempt(client, runId), bumpAttempt(client, runId)]),
    );

    const won = settled.filter((outcome) => outcome.status === "fulfilled");
    const lost = settled.filter((outcome) => outcome.status === "rejected");
    expect(won).toHaveLength(1);
    expect((won[0] as PromiseFulfilledResult<BumpedAttempt>).value).toMatchObject({
      attempt: 2,
      workflowId: `${runId}:2`,
    });
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrentBump);

    expect(await runRow(runId)).toMatchObject({ attempt: 2, current_workflow_id: `${runId}:2` });
  });
});

describe("fence.test.ts case (iv) — the workflow id existence assert", () => {
  it("throws WorkflowIdCollision and rolls the bump back", async () => {
    const runId = await createRun();
    await dbos.enqueue({ queueName: QUEUE, workflowName: FLOW, workflowID: `${runId}:2` }, { runId });

    await expect(bumpOnce(runId)).rejects.toBeInstanceOf(WorkflowIdCollision);

    expect(await runRow(runId)).toMatchObject({ attempt: 1, current_workflow_id: runId });
  });
});

describe("fence.test.ts case (v) — a swallowed failure inside a control-plane transaction", () => {
  it("throws CommitLost from the commit and persists nothing", async () => {
    const runId = await createRun();

    const error = await controlPlaneTx(control, { operation: "case-v" }, async (client) => {
      await client.query("UPDATE hf_run SET version = 'v-lost' WHERE run_id = $1", [runId]);
      try {
        // The shape the rule exists for: the audit insert of a control-plane operation fails
        // and its error is caught. From here Postgres answers COMMIT with a ROLLBACK tag.
        await client.query(
          "INSERT INTO hf_run (run_id, flow, status, current_workflow_id) VALUES ($1, 'demo', 'running', $1)",
          [runId],
        );
      } catch {
        /* swallowed on purpose: this is the rule being broken */
      }
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(CommitLost);
    expect((error as CommitLost).commandTag).toBe("ROLLBACK");
    expect(await runRow(runId)).toMatchObject({ version: null });
  });
});

describe("fence.test.ts case (vii) — control-plane operations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses both stand-ins from inside a workflow, before any statement", async () => {
    const runId = await createRun();
    vi.spyOn(DBOS, "isWithinWorkflow").mockReturnValue(true);
    const connect = vi.spyOn(control, "connect");

    await expect(decide(runId)).rejects.toBeInstanceOf(ControlPlaneInWorkflow);
    await expect(archive(runId)).rejects.toBeInstanceOf(ControlPlaneInWorkflow);

    expect(connect).not.toHaveBeenCalled();
    expect(await runRow(runId)).toMatchObject({ attempt: 1, status: "running" });
  });

  it("fails with 55P03 naming the run when it waits out the lock_timeout on a held ctx.tx", async () => {
    const runId = await createRun();
    const held = holdCtxTx(runId);
    await held.fenced;

    const error = await decide(runId, "250ms").then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    await held.release();

    expect(error).toBeInstanceOf(RunLockTimeout);
    expect((error as RunLockTimeout).code).toBe("55P03");
    expect((error as RunLockTimeout).message).toContain(runId);
    expect(((error as RunLockTimeout).cause as { code?: string }).code).toBe("55P03");
    expect(await runRow(runId)).toMatchObject({ attempt: 1, current_workflow_id: runId });
  });
});

describe("the bump path and enqueueInTransaction", () => {
  it("enqueues the new attempt in the bump's own transaction", async () => {
    const runId = await createRun();

    const bumped = await controlPlaneTx(control, { operation: "runs.resume" }, async (client) => {
      const bump = await bumpAttempt(client, runId);
      await dbos.enqueueInTransaction(
        client,
        { queueName: QUEUE, workflowName: bump.flow, workflowID: bump.workflowId },
        { runId, attempt: bump.attempt, input: bump.input },
      );
      return bump;
    });

    expect(bumped).toMatchObject({ flow: FLOW, workflowId: `${runId}:2` });
    expect(await workflowStatus(bumped.workflowId)).toMatchObject({
      status: "ENQUEUED",
      queue_name: QUEUE,
    });
  });

  it("leaves no workflow row when the transaction rolls back", async () => {
    const runId = await createRun();

    await expect(
      controlPlaneTx(control, { operation: "runs.resume" }, async (client) => {
        const bump = await bumpAttempt(client, runId);
        await dbos.enqueueInTransaction(
          client,
          { queueName: QUEUE, workflowName: bump.flow, workflowID: bump.workflowId },
          { runId, attempt: bump.attempt, input: bump.input },
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await workflowStatus(`${runId}:2`)).toBeUndefined();
    expect(await runRow(runId)).toMatchObject({ attempt: 1, current_workflow_id: runId });
  });
});

describe("redeploy case 8's unit half — the bump path driven twice", () => {
  it("moves the fencing token to :2 and then :3", async () => {
    const runId = await createRun();

    expect(await bumpOnce(runId)).toMatchObject({ previousAttempt: 1, attempt: 2 });
    expect(await runRow(runId)).toMatchObject({ attempt: 2, current_workflow_id: `${runId}:2` });

    expect(await bumpOnce(runId)).toMatchObject({ previousAttempt: 2, attempt: 3 });
    expect(await runRow(runId)).toMatchObject({ attempt: 3, current_workflow_id: `${runId}:3` });
  });
});

/**
 * Stand-ins for the two control-plane operations case (vii) names: `approvals.decide()` lands at
 * chunk 12 and `records.archive()` at chunk 13. What (vii) is about is the helper's guard and its
 * lock bound, which is all either of them has here.
 */
function decide(runId: string, lockTimeout?: string): Promise<BumpedAttempt> {
  return controlPlaneTx(control, { operation: "approvals.decide", lockTimeout }, (client) =>
    bumpAttempt(client, runId),
  );
}

function archive(runId: string): Promise<void> {
  return controlPlaneTx(control, { operation: "records.archive" }, async (client) => {
    await client.query("UPDATE hf_run SET record_id = NULL WHERE run_id = $1", [runId]);
  });
}

function bumpOnce(runId: string): Promise<BumpedAttempt> {
  return controlPlaneTx(control, { operation: "reconcile" }, (client) => bumpAttempt(client, runId));
}

/** A `ctx.tx` parked after its fence statement, holding `FOR SHARE` on the run's row. */
function holdCtxTx(runId: string): { fenced: Promise<void>; release: () => Promise<void> } {
  let fenced!: () => void;
  let release!: () => void;
  const fencedAt = new Promise<void>((resolve) => {
    fenced = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction = step.tx(runId, runId, async () => {
    fenced();
    await released;
  });

  return {
    fenced: fencedAt,
    release: async () => {
      release();
      await transaction;
    },
  };
}

let runs = 0;

/** A fresh `hf_run` row per case, so a bump never moves the row case (vi) fences against. */
async function createRun(): Promise<string> {
  const runId = `bump-run-${++runs}`;
  await asRole(database.applicationUrl, async (client) => {
    await client.query(
      `INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id)
       VALUES ($1, $2, $3, 'running', 1, $1)`,
      [runId, FLOW, JSON.stringify({ run: runId })],
    );
  });
  return runId;
}

interface RunRow {
  attempt: number;
  current_workflow_id: string;
  status: string;
  version: string | null;
}

/** Reads the row on a connection of its own, so an assertion never joins the transaction. */
async function runRow(runId: string): Promise<RunRow> {
  return asRole(database.applicationUrl, async (client) => {
    const { rows } = await client.query<RunRow>(
      "SELECT attempt, current_workflow_id, status, version FROM hf_run WHERE run_id = $1",
      [runId],
    );
    return rows[0]!;
  });
}

async function workflowStatus(
  workflowId: string,
): Promise<{ status: string; queue_name: string | null } | undefined> {
  return asRole(database.applicationUrl, async (client) => {
    const { rows } = await client.query<{ status: string; queue_name: string | null }>(
      "SELECT status, queue_name FROM dbos.workflow_status WHERE workflow_uuid = $1",
      [workflowId],
    );
    return rows[0];
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backendPid(db: StepDatabase): Promise<number> {
  const result = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
  return Number(result.rows[0]!.pid);
}
