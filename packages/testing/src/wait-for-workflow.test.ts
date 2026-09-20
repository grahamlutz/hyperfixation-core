import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./database.js";
import { waitForWorkflowStatus, WorkflowNeverMatched } from "./wait-for-workflow.js";

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

async function enqueue(workflowId: string): Promise<void> {
  await pool.query(
    "INSERT INTO dbos.workflow_status (workflow_uuid, status, name, application_version) " +
      "VALUES ($1, 'PENDING', 'test', 'v1')",
    [workflowId],
  );
}

describe("waitForWorkflowStatus", () => {
  it("answers with the row once the workflow reaches the status", async () => {
    await enqueue("wf-success");
    setTimeout(() => {
      void pool.query(
        "UPDATE dbos.workflow_status SET status = 'SUCCESS' WHERE workflow_uuid = 'wf-success'",
      );
    }, 150);

    const workflow = await waitForWorkflowStatus(pool, "wf-success", "SUCCESS", {
      timeoutMs: 10_000,
      intervalMs: 20,
    });

    expect(workflow).toMatchObject({
      workflowId: "wf-success",
      status: "SUCCESS",
      applicationVersion: "v1",
    });
  });

  it("times out with the last status it saw", async () => {
    await enqueue("wf-stuck");

    const error = await waitForWorkflowStatus(pool, "wf-stuck", "SUCCESS", {
      timeoutMs: 200,
      intervalMs: 20,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(WorkflowNeverMatched);
    expect((error as WorkflowNeverMatched).lastSeen).toMatchObject({ status: "PENDING" });
    expect((error as Error).message).toContain("never reached SUCCESS within 200ms");
    expect((error as Error).message).toContain("status=PENDING application_version=v1");
  });

  it("says there was no row at all when the workflow never existed", async () => {
    const error = await waitForWorkflowStatus(pool, "wf-missing", "SUCCESS", {
      timeoutMs: 100,
      intervalMs: 20,
    }).catch((e: unknown) => e);

    expect((error as WorkflowNeverMatched).lastSeen).toBeUndefined();
    expect((error as Error).message).toContain("no dbos.workflow_status row");
  });
});
