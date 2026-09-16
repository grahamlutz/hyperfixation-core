import { EventEmitter } from "node:events";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UnfencedWrite, unfencedWriteOf } from "./fenced-client.js";
import { migrate } from "./migrate.js";
import { createStepPool, StaleAttempt, type StepDatabase, type StepPool } from "./step-pool.js";
import { asRole, createTestDatabase, type TestDatabase } from "./test-support/database.js";
import { countRuns, stampVersion } from "./test-support/sibling-helper.js";

const RUN_ID = "fence-run";
const WORKFLOW_ID = "fence-run";
const READ = "SELECT 1";

const writeSql = (marker: string) =>
  `UPDATE hf_run SET version = '${marker}' WHERE run_id = '${RUN_ID}'`;

let database: TestDatabase;
let step: StepPool;

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
}, 60_000);

afterAll(async () => {
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
     * Drizzle releases the client in a `finally` that only guards the body — a `BEGIN` that
     * throws leaks the checkout — so the test reclaims it through the pool's `acquire` event
     * rather than letting the leak drain the pool.
     */
    async function transactionOnPool(work: (tx: StepDatabase) => Promise<unknown>) {
      let acquired: PoolClient | undefined;
      let leaked = true;
      const capture = (client: PoolClient) => {
        acquired = client;
      };
      step.pool.once("acquire", capture);
      try {
        const result = await step.db.transaction(work as never);
        leaked = false;
        return result;
      } finally {
        step.pool.removeListener("acquire", capture);
        if (leaked) acquired?.release();
      }
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

async function backendPid(db: StepDatabase): Promise<number> {
  const result = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
  return Number(result.rows[0]!.pid);
}
