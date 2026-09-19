import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { RunNeverMatched, waitForRun } from "./wait-for-run.js";

let database: TestDatabase;
let pool: Pool;

beforeAll(async () => {
  database = await createTestDatabase();
  pool = new Pool({ max: 2, connectionString: database.applicationUrl });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

async function startRun(runId: string, status = "running"): Promise<void> {
  await pool.query(
    "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
      "VALUES ($1, 'test', '{}', $2, 1, $1)",
    [runId, status],
  );
}

describe("waitForRun", () => {
  it("answers with the row once the run reaches the status", async () => {
    await startRun("wait-done");
    setTimeout(() => {
      void pool.query(
        "UPDATE hf_run SET status = 'done', finished_at = now() WHERE run_id = 'wait-done'",
      );
    }, 150);

    const run = await waitForRun(pool, "wait-done", "done", { timeoutMs: 10_000, intervalMs: 20 });

    expect(run).toMatchObject({ runId: "wait-done", status: "done", attempt: 1 });
    expect(run.finishedAt).toBeInstanceOf(Date);
  });

  it("takes a predicate for what the status alone cannot say", async () => {
    await startRun("wait-attempt");
    await pool.query(
      "UPDATE hf_run SET attempt = 2, current_workflow_id = 'wait-attempt:2' " +
        "WHERE run_id = 'wait-attempt'",
    );

    const run = await waitForRun(pool, "wait-attempt", (r) => r.attempt === 2, {
      timeoutMs: 10_000,
      intervalMs: 20,
    });

    expect(run.currentWorkflowId).toBe("wait-attempt:2");
  });

  it("times out with the last state it saw", async () => {
    await startRun("wait-stuck", "waiting");

    const error = await waitForRun(pool, "wait-stuck", "done", {
      timeoutMs: 200,
      intervalMs: 20,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RunNeverMatched);
    expect((error as RunNeverMatched).lastSeen).toMatchObject({ status: "waiting" });
    expect((error as Error).message).toContain("never reached done within 200ms");
    expect((error as Error).message).toContain("status=waiting attempt=1");
  });

  it("says there was no row at all when the run never existed", async () => {
    const error = await waitForRun(pool, "wait-missing", "done", {
      timeoutMs: 100,
      intervalMs: 20,
    }).catch((e: unknown) => e);

    expect((error as RunNeverMatched).lastSeen).toBeUndefined();
    expect((error as Error).message).toContain("no hf_run row");
  });
});
