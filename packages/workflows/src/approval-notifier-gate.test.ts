import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import {
  assertNoFencingFailure,
  asRole,
  createTestDatabase,
  killAt,
  killWhenParked,
  spawnWorker,
  testBuildSha,
  type SpawnedWorker,
  type TestDatabase,
} from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_RECIPIENTS_MARKER, type ApprovalMessage } from "./approval-notifier.js";
import { getClient, resetClient } from "./client.js";
import { createControlPool, type ControlPool } from "./control-pool.js";
import { runsStart } from "./runs.js";
import {
  notifierFlow,
  NOTIFIER_KEY,
  NOTIFY_PARK_KEY,
  OWN_NOTIFY_MARKER,
  SENT_MARKER,
} from "./test-support/notifier-flow.js";

const NOTIFIER_MODULE = new URL("./test-support/notifier-flow-fixture.ts", import.meta.url).pathname;

let database: TestDatabase;
let control: ControlPool;
let client: DBOSClient;

async function seed(): Promise<void> {
  await asRole(database.migratorUrl, async (pg) => {
    await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, '10')");
    await pg.query(
      "INSERT INTO hf_user (id, name, email) VALUES ('crystal', 'Crystal', 'crystal@test')",
    );
  });
}

async function waitForStatus(runId: string, status: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await control.pool.query<{ status: string }>(
      "SELECT status FROM hf_run WHERE run_id = $1",
      [runId],
    );
    if (rows[0]?.status === status) return;
    if (Date.now() > deadline) {
      throw new Error(`hf_run ${runId} never reached ${status} (still ${rows[0]?.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface ApprovalRow extends Record<string, unknown> {
  id: string;
  status: string;
  notified_at: Date | null;
}

async function approvalsOf(runId: string): Promise<ApprovalRow[]> {
  const { rows } = await control.pool.query<ApprovalRow>(
    "SELECT id, status, notified_at FROM hf_approval WHERE run_id = $1 ORDER BY id",
    [runId],
  );
  return rows;
}

/** Every message the worker's notifier has sent so far, parsed back out of its log. */
function sent(worker: SpawnedWorker): ApprovalMessage[] {
  return worker
    .output()
    .split("\n")
    .filter((line) => line.includes(SENT_MARKER))
    .map(
      (line) =>
        JSON.parse(line.slice(line.indexOf(SENT_MARKER) + SENT_MARKER.length)) as ApprovalMessage,
    );
}

describe("the worker's approvalNotifier, through waitForApproval", () => {
  let worker: SpawnedWorker;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed();

    worker = spawnWorker({
      module: NOTIFIER_MODULE,
      appName: database.appName,
      databaseUrl: database.applicationUrl,
    });
    await worker.ready();

    control = createControlPool({ connectionString: database.applicationUrl });
    client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
  }, 120_000);

  afterAll(async () => {
    await resetClient();
    await control?.end();
    await worker?.kill();
    await database?.drop();
  });

  it(
    "notifies once, and stamps notified_at, when the call passes no notify of its own",
    async () => {
      const runId = `notifier-${testBuildSha()}`;
      await runsStart(control.pool, client, notifierFlow, { assigneeId: "crystal" }, { runId });

      await waitForStatus(runId, "waiting");
      const [row] = await approvalsOf(runId);
      expect(row).toMatchObject({ status: "pending" });
      expect(row!.notified_at).not.toBeNull();

      const messages = sent(worker);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        to: ["crystal@test"],
        subject: "Approval needed: send-email",
        url: `https://workspace.test/w/approvals/${row!.id}`,
      });
      assertNoFencingFailure(worker);
    },
    120_000,
  );

  it(
    "leaves the notifier alone when the call passes its own notify",
    async () => {
      const runId = `notifier-own-${testBuildSha()}`;
      const before = sent(worker).length;
      await runsStart(
        control.pool,
        client,
        notifierFlow,
        { assigneeId: "crystal", ownNotify: true },
        { runId },
      );

      await waitForStatus(runId, "waiting");
      expect(worker.output()).toContain(`${OWN_NOTIFY_MARKER} ${NOTIFIER_KEY}`);
      expect(sent(worker)).toHaveLength(before);
      const [row] = await approvalsOf(runId);
      expect(row!.notified_at).not.toBeNull();
    },
    120_000,
  );

  it(
    "warns and sends nothing for an approval with no recipients, and still stamps notified_at",
    async () => {
      const runId = `notifier-none-${testBuildSha()}`;
      const before = sent(worker).length;
      await runsStart(control.pool, client, notifierFlow, { assigneeId: "ghost" }, { runId });

      await waitForStatus(runId, "waiting");
      expect(sent(worker)).toHaveLength(before);
      expect(worker.output()).toContain(NO_RECIPIENTS_MARKER);
      const [row] = await approvalsOf(runId);
      expect(row!.notified_at).not.toBeNull();
    },
    120_000,
  );
});

describe("the notifier's at-least-once delivery across a crash inside the notify step", () => {
  let workerA: SpawnedWorker;
  let workerB: SpawnedWorker;

  beforeAll(async () => {
    database = await createTestDatabase();
    await seed();
    control = createControlPool({ connectionString: database.applicationUrl });
    client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
  }, 120_000);

  afterAll(async () => {
    await resetClient();
    await control?.end();
    await workerA?.kill().catch(() => undefined);
    await workerB?.kill().catch(() => undefined);
    await database?.drop();
  });

  /**
   * `notified_at` is stamped after the notifier returns, so a crash between the send and the
   * stamp costs a second message and never a lost one — the documented trade, asserted rather
   * than papered over. One approval row throughout: the re-entry's `ON CONFLICT DO NOTHING`.
   */
  it(
    "sends a second message on the re-entry, and keeps the one approval row",
    async () => {
      const runId = `notifier-crash-${testBuildSha()}`;
      const parked = killAt(NOTIFY_PARK_KEY, "before-checkpoint");

      workerA = spawnWorker({
        module: NOTIFIER_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
        control: { killAt: parked },
      });
      await workerA.ready();
      await runsStart(control.pool, client, notifierFlow, { assigneeId: "crystal" }, { runId });

      await killWhenParked(workerA, parked, 120_000);
      assertNoFencingFailure(workerA);
      expect(sent(workerA)).toHaveLength(1);
      const [first] = await approvalsOf(runId);
      expect(first!.notified_at).toBeNull();

      workerB = spawnWorker({
        module: NOTIFIER_MODULE,
        appName: database.appName,
        databaseUrl: database.applicationUrl,
      });
      await workerB.ready();
      await waitForStatus(runId, "waiting", 120_000);

      expect(sent(workerB)).toHaveLength(1);
      assertNoFencingFailure(workerB);
      const rows = await approvalsOf(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: first!.id, status: "pending" });
      expect(rows[0]!.notified_at).not.toBeNull();
    },
    300_000,
  );
});
