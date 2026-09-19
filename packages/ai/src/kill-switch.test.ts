import type { LanguageModelV4, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { createStepPool, type StepPool } from "@hyperfixation/db";
import {
  createTestDatabase,
  MockLanguageModel,
  MOCK_MODEL_ID,
  MOCK_PROVIDER,
  testBuildSha,
  type TestDatabase,
} from "@hyperfixation/testing";
import { decide, getClient, reconcile, resetClient } from "@hyperfixation/workflows";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BudgetExceeded } from "./errors.js";
import { hashInput } from "./input-hash.js";
import { createLlm, type LedgerContext, type Llm } from "./llm-run.js";
import { createProviders, fixedCost } from "./providers.js";
import {
  budgetPeriod,
  currentPeriod,
  derivedReservation,
  ledgerProbe,
  ledgerRows,
  runRow,
  seedAppState,
  startRun,
  type LedgerProbe,
} from "./test-support/ledger-harness.js";
import { llmFlow } from "./test-support/llm-flow.js";
import { PROMPTS_DIR } from "./test-support/prompts-dir.js";

const BUDGET_USD = "1.00";
const ESTIMATE_USD = 0.005;
const OVER_BUDGET_USD = 1.5;

const ORPHANS = 100;
const PASSES = 100;

const CALL = { key: "x", model: MOCK_MODEL_ID, prompt: "draft", input: { a: 1 } };

/** The registry a cassette needs: one named model, one flat price, one prompt directory. */
function ledger(model: LanguageModelV4, estimatedCostUsd: number, costUsd = estimatedCostUsd): Llm {
  return createLlm({
    providers: createProviders({
      models: { [MOCK_MODEL_ID]: model },
      costs: { [MOCK_MODEL_ID]: fixedCost(estimatedCostUsd, costUsd) },
    }),
    promptsDir: PROMPTS_DIR,
  });
}

/**
 * A provider call held open. The gate has committed its `started` row and the answer is still in
 * flight — the one window a kill can orphan a row in, and the only one in which the row's own
 * reservation is there to be read.
 */
class ParkedCall implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = MOCK_PROVIDER;
  readonly modelId = MOCK_MODEL_ID;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  /** Resolves once the gate has committed and the provider has been entered. */
  readonly entered: Promise<void>;
  calls = 0;

  private enter!: () => void;
  private answer: ((result: LanguageModelV4GenerateResult) => void) | undefined;

  constructor() {
    this.entered = new Promise<void>((resolve) => {
      this.enter = resolve;
    });
  }

  doGenerate(): Promise<LanguageModelV4GenerateResult> {
    this.calls += 1;
    this.enter();
    return new Promise((resolve) => {
      this.answer = resolve;
    });
  }

  /** Lets the parked call answer, which is what carries its row to `ok`. */
  release(text: string): void {
    this.answer?.({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    });
  }

  doStream(): never {
    throw new Error(`${this.modelId}: a parked call is never streamed`);
  }
}

/**
 * The kill switch: `BudgetExceeded` is the only thing standing between a looping flow and an
 * unbounded bill, and round-2 finding 3 disabled it permanently with a counter that walked
 * negative. There is no counter any more — the reservation is derived from `started` rows — so
 * what this file asserts is that a hundred orphans and a hundred passes over them move the
 * switch not at all.
 */
describe("a hundred orphaned reservations under a hundred reconcile passes", () => {
  let database: TestDatabase;
  let probe: LedgerProbe;
  let steps: StepPool;
  let client: DBOSClient;

  beforeAll(async () => {
    database = await createTestDatabase();
    probe = ledgerProbe(database);
    await seedAppState(database, BUDGET_USD);
    steps = createStepPool({ connectionString: database.applicationUrl });
    client = await getClient({
      appName: database.appName,
      databaseUrl: database.applicationUrl,
    });
  }, 60_000);

  afterAll(async () => {
    await resetClient();
    await steps?.end();
    await probe?.close();
    await database?.drop();
  });

  it(
    "abandons each row once, reserves nothing, spends nothing, and still refuses the next run",
    async () => {
      // One real call first, so "the period's `spent_usd` is unchanged" is a claim about a
      // figure that is not zero, and so the period row exists because a gate created it.
      const spender = `kill-switch-spent-${testBuildSha()}`;
      const model = new MockLanguageModel({
        responses: [{ text: "billed", inputTokens: 10, outputTokens: 5 }],
      });
      await expect(
        ledger(model, ESTIMATE_USD).run(await runningRun(spender), CALL),
      ).resolves.toEqual({ text: "billed" });
      await finish(spender);

      const period = await currentPeriod(probe);
      await orphanStartedRows(period);

      // Before any pass: the rows reserve nothing already, because the reservation only counts
      // rows whose run is still `running`. The passes below are hygiene on top of that.
      expect(await startedCount(probe)).toBe(ORPHANS);
      expect(await derivedReservation(probe, period)).toBe("0");
      const spentBefore = (await budgetPeriod(probe, period))?.spent_usd;
      expect(Number(spentBefore)).toBeCloseTo(ESTIMATE_USD, 6);

      const first = await reconcile(probe.pool, client, { applicationVersion: testBuildSha() });
      expect(first.abandonedLlmCalls).toBe(ORPHANS);
      expect(first).toMatchObject({ anomalies: [], failures: [], reattempted: [] });
      const abandoned = await abandonedRows(probe);
      expect(abandoned).toHaveLength(ORPHANS);

      // `WHERE status = 'started'` is the idempotency, so the remaining passes transition
      // nothing and no `finished_at` moves.
      for (let pass = 1; pass < PASSES; pass += 1) {
        const report = await reconcile(probe.pool, client, { applicationVersion: testBuildSha() });
        expect(report).toMatchObject({ abandonedLlmCalls: 0, anomalies: [], failures: [] });
      }
      expect(await abandonedRows(probe)).toEqual(abandoned);
      expect(await startedCount(probe)).toBe(0);
      expect(await derivedReservation(probe, period)).toBe("0");
      expect((await budgetPeriod(probe, period))?.spent_usd).toBe(spentBefore);

      const refused = new MockLanguageModel({ responses: [{ text: "never" }] });
      await expect(
        ledger(refused, OVER_BUDGET_USD).run(
          await runningRun(`kill-switch-over-${testBuildSha()}`),
          CALL,
        ),
      ).rejects.toBeInstanceOf(BudgetExceeded);
      expect(refused.callCount).toBe(0);

      // And it fires at the budget, not below it: a hundred abandoned rows starve nothing,
      // which is the half of finding 6 that a refusal would silently break.
      const allowed = new MockLanguageModel({
        responses: [{ text: "still allowed", inputTokens: 10, outputTokens: 5 }],
      });
      await expect(
        ledger(allowed, ESTIMATE_USD).run(
          await runningRun(`kill-switch-under-${testBuildSha()}`),
          CALL,
        ),
      ).resolves.toEqual({ text: "still allowed" });
      expect(Number((await budgetPeriod(probe, period))?.spent_usd)).toBeCloseTo(
        2 * ESTIMATE_USD,
        6,
      );
    },
    60_000,
  );

  /**
   * The defect state, a hundred times: a run that ended `failed` with its `started` row still on
   * the attempt that was current when the process died. Written directly rather than by killing a
   * hundred workers — redeploy case 9 already proves a real kill leaves exactly this row, and what
   * this case is about is what a hundred of them do to the reservation.
   */
  async function orphanStartedRows(period: string): Promise<void> {
    await probe.pool.query(
      `INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id, error)
       SELECT 'kill-switch-orphan-' || i, 'llmFlow', '{}'::jsonb, 'failed', 1,
              'kill-switch-orphan-' || i || ':1', 'the worker died mid-call'
       FROM generate_series(1, $1) AS g(i)`,
      [ORPHANS],
    );
    await probe.pool.query(
      `INSERT INTO hf_llm_call
         (run_id, key, workflow_id, period, input_hash, model, prompt_name, status,
          estimated_cost_usd)
       SELECT 'kill-switch-orphan-' || i, 'x', 'kill-switch-orphan-' || i || ':1', $2, $3,
              $4, 'draft', 'started', $5::numeric
       FROM generate_series(1, $1) AS g(i)`,
      [ORPHANS, period, hashInput(CALL.input), MOCK_MODEL_ID, ESTIMATE_USD],
    );
  }

  async function runningRun(runId: string): Promise<LedgerContext> {
    await probe.pool.query(
      "INSERT INTO hf_run (run_id, flow, input, status, attempt, current_workflow_id) " +
        "VALUES ($1, 'llmFlow', '{}', 'running', 1, $1)",
      [runId],
    );
    return { runId, workflowId: runId, tx: (work) => steps.tx(runId, runId, work) };
  }

  /** A run left `running` with no workflow row is an anomaly to every pass; this one is over. */
  async function finish(runId: string): Promise<void> {
    await probe.pool.query(
      "UPDATE hf_run SET status = 'done', finished_at = now() WHERE run_id = $1",
      [runId],
    );
  }
});

/**
 * The case redeploy case 9 deferred: the row it left `abandoned` belongs to a run that is
 * `waiting`, not one that failed, so a later attempt does reach it. Re-entry happens inside the
 * gate, under the period row's lock, and is budget-checked exactly like a fresh insert.
 */
describe("an abandoned row revisited by a later attempt of a waiting run", () => {
  let database: TestDatabase;
  let probe: LedgerProbe;
  let steps: StepPool;
  let client: DBOSClient;

  beforeAll(async () => {
    database = await createTestDatabase();
    probe = ledgerProbe(database);
    await seedAppState(database, BUDGET_USD);
    steps = createStepPool({ connectionString: database.applicationUrl });
    client = await getClient({
      appName: database.appName,
      databaseUrl: database.applicationUrl,
    });
  }, 60_000);

  afterAll(async () => {
    await resetClient();
    await steps?.end();
    await probe?.close();
    await database?.drop();
  });

  it(
    "flags it, reserves it again under the current attempt, and bills it once",
    async () => {
      const runId = `kill-switch-waiting-${testBuildSha()}`;
      await startRun(probe, llmFlow(), { keys: ["x"], estimatedCostUsd: 0, costUsd: 0 }, runId);
      const first = (await runRow(probe, runId))!.current_workflow_id;

      // Attempt 1 dies with the provider's answer in flight: the row stays `started`, and the
      // answer never arrives, exactly as it never arrives for a process that is gone.
      const parkedFirst = new ParkedCall();
      void ledger(parkedFirst, ESTIMATE_USD).run(context(runId, first), CALL);
      await parkedFirst.entered;
      expect((await ledgerRows(probe, runId))[0]).toMatchObject({
        status: "started",
        workflow_id: first,
      });

      // `waitForApproval` parks the run: its current workflow has ended, so the pass abandons
      // the row even though the run is far from over.
      await probe.pool.query("UPDATE hf_run SET status = 'waiting' WHERE run_id = $1", [runId]);
      const approvalId = await pendingApproval(runId, first);
      const hygiene = await reconcile(probe.pool, client, {
        applicationVersion: testBuildSha(),
      });
      expect(hygiene.abandonedLlmCalls).toBe(1);

      const period = await currentPeriod(probe);
      expect((await ledgerRows(probe, runId))[0]).toMatchObject({ status: "abandoned" });
      expect(await derivedReservation(probe, period)).toBe("0");

      const decided = await decide(probe.pool, client, {
        ids: [approvalId],
        decision: "approved",
        via: "web",
        decisionKey: `kill-switch-${approvalId}`,
        userId: "crystal",
      });
      const second = decided.decided[0]!.resumeWorkflowId;
      expect(await runRow(probe, runId)).toMatchObject({
        status: "running",
        attempt: 2,
        current_workflow_id: second,
      });

      const parkedSecond = new ParkedCall();
      const replay = ledger(parkedSecond, ESTIMATE_USD).run(context(runId, second), CALL);
      await parkedSecond.entered;

      // Flagged, `started` under attempt 2, and reserving again — a row re-entering the
      // reservation is the thing round-3 finding 8 made the gate do under the period's lock.
      expect((await ledgerRows(probe, runId))[0]).toMatchObject({
        status: "started",
        workflow_id: second,
        possible_double_charge: true,
        finished_at: null,
      });
      expect(Number(await derivedReservation(probe, period))).toBeCloseTo(ESTIMATE_USD, 6);

      parkedSecond.release("second answer");
      await expect(replay).resolves.toEqual({ text: "second answer" });

      const rows = await ledgerRows(probe, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "ok",
        workflow_id: second,
        possible_double_charge: true,
      });
      expect(await derivedReservation(probe, period)).toBe("0");
      expect(Number((await budgetPeriod(probe, period))?.spent_usd)).toBeCloseTo(ESTIMATE_USD, 6);

      // Moved to `ok` once: a third execution of the same key is served from the row, and the
      // two calls the provider did see are the two attempts — the flag is the audit trail.
      await expect(
        ledger(parkedSecond, ESTIMATE_USD).run(context(runId, second), CALL),
      ).resolves.toEqual({ text: "second answer" });
      expect(parkedFirst.calls + parkedSecond.calls).toBe(2);
      expect(Number((await budgetPeriod(probe, period))?.spent_usd)).toBeCloseTo(ESTIMATE_USD, 6);
    },
    60_000,
  );

  /** A pending approval, the shape `waitForApproval` leaves behind before it suspends. */
  async function pendingApproval(runId: string, workflowId: string): Promise<number> {
    const { rows } = await probe.pool.query<{ id: string }>(
      "INSERT INTO hf_approval (run_id, key, workflow_id, type, draft, status) " +
        "VALUES ($1, 'send', $2, 'send-email', '{\"body\":\"draft\"}'::jsonb, 'pending') " +
        "RETURNING id",
      [runId, workflowId],
    );
    return Number(rows[0]!.id);
  }

  function context(runId: string, workflowId: string): LedgerContext {
    return { runId, workflowId, tx: (work) => steps.tx(runId, workflowId, work) };
  }
});

async function startedCount(probe: LedgerProbe): Promise<number> {
  const { rows } = await probe.pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM hf_llm_call WHERE status = 'started'",
  );
  return Number(rows[0]!.n);
}

async function abandonedRows(
  probe: LedgerProbe,
): Promise<{ run_id: string; finished_at: Date }[]> {
  const { rows } = await probe.pool.query<{ run_id: string; finished_at: Date }>(
    "SELECT run_id, finished_at FROM hf_llm_call WHERE status = 'abandoned' ORDER BY run_id",
  );
  return rows;
}
