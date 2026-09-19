import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";
import { createStepPool, LOCK_NOT_AVAILABLE, type StepDatabase, type StepPool } from "@hyperfixation/db";
import {
  asRole,
  createTestDatabase,
  MockLanguageModel,
  MOCK_MODEL_ID,
  testBuildSha,
  withClock,
  type TestClock,
  type TestDatabase,
} from "@hyperfixation/testing";
import { decide, defineFlow, getClient, reconcile, resetClient, type Flow } from "@hyperfixation/workflows";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BudgetExceeded } from "./errors.js";
import { hashInput } from "./input-hash.js";
import { createLlm, type LedgerContext, type Llm } from "./llm-run.js";
import { createProviders, fixedCost } from "./providers.js";
import {
  budgetPeriod,
  currentPeriod,
  derivedReservation,
  ledgerRows,
  runRow,
  seedAppState,
  startRun,
  type LedgerProbe,
} from "./test-support/ledger-harness.js";
import { ParkedCall } from "./test-support/parked-call.js";
import { PROMPTS_DIR } from "./test-support/prompts-dir.js";

/** Postgres `deadlock_detected`: the one error the lock order exists to make impossible. */
const DEADLOCK = "40P01";

const BUDGET_USD = "1000";
const PROBE_POOL_SIZE = 10;

const STRESS_ITERATIONS = 200;
const STRESS_RUNS = 8;
const STRESS_ESTIMATE_USD = 0.001;

let database: TestDatabase;
let probe: LedgerProbe;
let steps: StepPool;
let client: DBOSClient;
let flow: Flow<{ n: number }, void>;
let period: string;

/** The registry the cassette needs: one named model, one flat price, one prompt directory. */
function ledger(
  model: LanguageModelV4,
  estimatedCostUsd: number,
  costUsd = estimatedCostUsd,
  clock?: () => Date,
): Llm {
  return createLlm({
    providers: createProviders({
      models: { [MOCK_MODEL_ID]: model },
      costs: { [MOCK_MODEL_ID]: fixedCost(estimatedCostUsd, costUsd) },
    }),
    promptsDir: PROMPTS_DIR,
    clock,
  });
}

function stepContext(runId: string, workflowId: string): LedgerContext {
  return { runId, workflowId, tx: (work) => steps.tx(runId, workflowId, work) };
}

function runIdFor(name: string): string {
  return `${name}-${testBuildSha()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Every Postgres error code in a thrown error and its causes; `RunLockTimeout` wraps one. */
function codesOf(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    const { code } = current as Error & { code?: unknown };
    if (typeof code === "string") codes.push(code);
    current = current.cause;
  }
  return codes;
}

function lockFailuresIn(errors: readonly unknown[]): string[] {
  return errors
    .flatMap(codesOf)
    .filter((code) => code === DEADLOCK || code === LOCK_NOT_AVAILABLE);
}

/** A connection of the test's own, to hold a row lock while production code runs into it. */
async function holder(): Promise<Client> {
  const connection = new Client({ connectionString: database.applicationUrl });
  await connection.connect();
  await connection.query("BEGIN");
  return connection;
}

/**
 * Backends blocked on a lock *in this database only* — the shared instance's other databases are
 * other suites. Waiting for this rather than for a sleep is what makes the lock-step deterministic.
 * `pg_stat_activity` rather than `pg_locks`: a row-lock waiter waits on the holder's
 * `transactionid` lock, whose `pg_locks.database` is null, so it cannot be scoped to a database.
 */
async function blockedBackends(): Promise<number> {
  const { rows } = await probe.pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM pg_stat_activity " +
      "WHERE datname = current_database() AND wait_event_type = 'Lock'",
  );
  return Number(rows[0]!.n);
}

async function waitForBlockedBackend(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await blockedBackends()) > 0) return;
    if (Date.now() > deadline) throw new Error("no backend ever blocked on the lock the test holds");
    await sleep(25);
  }
}

async function setPeriod(budgetUsd: string, spentUsd: string): Promise<void> {
  await probe.pool.query(
    "INSERT INTO hf_budget_period (period, budget_usd, spent_usd) VALUES ($1, $2, $3) " +
      "ON CONFLICT (period) DO UPDATE SET budget_usd = $2, spent_usd = $3",
    [period, budgetUsd, spentUsd],
  );
}

async function spentOf(): Promise<number> {
  return Number((await budgetPeriod(probe, period))?.spent_usd);
}

/** A pending approval, the shape `waitForApproval` leaves behind before it suspends. */
async function pending(runId: string, key: string): Promise<number> {
  const { rows } = await probe.pool.query<{ id: string }>(
    "INSERT INTO hf_approval (run_id, key, workflow_id, type, draft, status) " +
      "VALUES ($1, $2, $1, 'send-email', '{\"body\":\"draft\"}'::jsonb, 'pending') RETURNING id",
    [runId, key],
  );
  return Number(rows[0]!.id);
}

/** Never dispatched: no worker launches in this file, so the body is only here to be named. */
function budgetFlow(): Flow<{ n: number }, void> {
  return defineFlow<{ n: number }, void>("budgetFlow", () => Promise.resolve(), { queue: "llm" });
}

async function waitingRun(runId: string): Promise<void> {
  await startRun(probe, flow, { n: 1 }, runId);
  await probe.pool.query("UPDATE hf_run SET status = 'waiting' WHERE run_id = $1", [runId]);
}

beforeAll(async () => {
  database = await createTestDatabase();
  const pool = new Pool({ max: PROBE_POOL_SIZE, connectionString: database.applicationUrl });
  probe = { database, pool, close: () => pool.end() };
  await seedAppState(database, BUDGET_USD);
  steps = createStepPool({ connectionString: database.applicationUrl });
  client = await getClient({ appName: database.appName, databaseUrl: database.applicationUrl });
  flow = budgetFlow();
  period = await currentPeriod(probe);
}, 120_000);

afterAll(async () => {
  await resetClient();
  await steps?.end();
  await probe?.close();
  await database?.drop();
});

/**
 * (a) The period boundary. The clock is injected into the gate — `createLlm({ clock })`, the one
 * seam that takes one — not overridden in the database, so `finished_at`, `reconcile()` and
 * `status.ts` all still read real time and only the billing stamp moves.
 *
 * The dates are a century out on purpose: under today's real period the two months this case
 * arranges would be indistinguishable from what SQL `now()` used to return, and the test would
 * pass whether or not the injected clock was ever consulted.
 */
describe("budget.test.ts (a) — the period boundary", () => {
  const DECEMBER = "2099-12";
  const JANUARY = "2100-01";
  const PERIOD_BUDGET_USD = "1.00";
  const ESTIMATE_USD = 0.9;
  const COST_USD = 0.6;

  let clock: TestClock;

  async function setAppBudget(budgetUsd: string): Promise<void> {
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query("UPDATE hf_app_state SET budget_usd = $1 WHERE id = 1", [budgetUsd]);
    });
  }

  /** The workflow the run is actually on: a reservation only counts under that one. */
  async function liveContext(runId: string): Promise<LedgerContext> {
    return stepContext(runId, (await runRow(probe, runId))!.current_workflow_id);
  }

  async function spentIn(billed: string): Promise<number> {
    return Number((await budgetPeriod(probe, billed))?.spent_usd);
  }

  /** `spent_usd` minus what the period's `ok` rows say it should be. */
  async function driftIn(billed: string): Promise<number> {
    const { rows } = await probe.pool.query<{ drift: string }>(
      `SELECT (b.spent_usd - (SELECT COALESCE(SUM(cost_usd), 0) FROM hf_llm_call
                              WHERE period = $1 AND status = 'ok'))::text AS drift
       FROM hf_budget_period b WHERE b.period = $1`,
      [billed],
    );
    return Number(rows[0]!.drift);
  }

  beforeAll(async () => {
    clock = withClock("2099-12-31T23:59:58Z");
    // January's row is copied from `hf_app_state` by the gate that first needs it, so the copy
    // has to be small enough that December's reservation would refuse B if it counted.
    await setAppBudget(PERIOD_BUDGET_USD);
    await probe.pool.query(
      "INSERT INTO hf_budget_period (period, budget_usd, spent_usd) VALUES ($1, $2, 0)",
      [DECEMBER, PERIOD_BUDGET_USD],
    );
  });

  afterAll(async () => {
    await setAppBudget(BUDGET_USD);
  });

  it("bills each call to the period it reserved in, across a year rollover", async () => {
    const runA = runIdFor("budget-december");
    const runB = runIdFor("budget-january");
    await startRun(probe, flow, { n: 1 }, runA);
    await startRun(probe, flow, { n: 1 }, runB);

    const parkedA = new ParkedCall();
    const callA = ledger(parkedA, ESTIMATE_USD, COST_USD, clock)
      .run(await liveContext(runA), { key: "x", model: MOCK_MODEL_ID, prompt: "draft", input: { a: 1 } });
    await parkedA.entered;

    expect((await ledgerRows(probe, runA))[0]).toMatchObject({
      status: "started",
      period: DECEMBER,
    });
    expect(Number(await derivedReservation(probe, DECEMBER))).toBeCloseTo(ESTIMATE_USD, 6);

    // Midnight passes with A's answer still in flight.
    clock.set("2100-01-01T00:00:02Z");

    const parkedB = new ParkedCall();
    const callB = ledger(parkedB, ESTIMATE_USD, COST_USD, clock)
      .run(await liveContext(runB), { key: "x", model: MOCK_MODEL_ID, prompt: "draft", input: { b: 1 } });
    await parkedB.entered;

    // B's gate passed at all only because A's live December reservation counts nothing against
    // January: 0.9 + 0.9 does not fit the 1.00 January copied out of `hf_app_state`.
    expect((await ledgerRows(probe, runB))[0]).toMatchObject({
      status: "started",
      period: JANUARY,
    });
    expect(Number((await budgetPeriod(probe, JANUARY))?.budget_usd)).toBe(1);
    expect(await spentIn(JANUARY)).toBe(0);
    expect(Number(await derivedReservation(probe, JANUARY))).toBeCloseTo(ESTIMATE_USD, 6);

    parkedA.release("december");
    await callA;

    // A completed in January and was billed to December, which is the whole case.
    expect((await ledgerRows(probe, runA))[0]).toMatchObject({
      status: "ok",
      period: DECEMBER,
      possible_double_charge: false,
    });
    expect(await spentIn(DECEMBER)).toBeCloseTo(COST_USD, 6);
    expect(await spentIn(JANUARY)).toBe(0);

    parkedB.release("january");
    await callB;

    expect(await spentIn(JANUARY)).toBeCloseTo(COST_USD, 6);
    expect(await spentIn(DECEMBER)).toBeCloseTo(COST_USD, 6);
    expect(parkedA.calls).toBe(1);
    expect(parkedB.calls).toBe(1);
    expect(await driftIn(DECEMBER)).toBe(0);
    expect(await driftIn(JANUARY)).toBe(0);
  }, 120_000);
});

describe("budget.test.ts (b) — re-entry through the gate at the budget", () => {
  it("refuses the replaying attempt and leaves the abandoned row exactly as it was", async () => {
    const runId = runIdFor("budget-reentry");
    await waitingRun(runId);
    // The period at budget − $0.50, so the $1 the row re-reserves is what does not fit.
    await setPeriod("10", "9.5");

    const input = { a: 1 };
    await probe.pool.query(
      `INSERT INTO hf_llm_call
         (run_id, key, workflow_id, period, input_hash, model, prompt_name, prompt_hash, status,
          estimated_cost_usd, finished_at)
       VALUES ($1, 'x', $1, $2, $3, $4, 'draft', 'abandoned-hash', 'abandoned', 1.0, now())`,
      [runId, period, hashInput(input), MOCK_MODEL_ID],
    );
    const abandoned = (await ledgerRows(probe, runId))[0];
    const approvalId = await pending(runId, "send");

    const decided = await decide(probe.pool, client, {
      ids: [approvalId],
      decision: "approved",
      via: "web",
      decisionKey: `web-${runId}`,
      userId: "crystal",
    });
    const resumeWorkflowId = decided.decided[0]!.resumeWorkflowId;
    expect(await runRow(probe, runId)).toMatchObject({
      status: "running",
      current_workflow_id: resumeWorkflowId,
    });

    const model = new MockLanguageModel({ responses: [{ text: "never" }] });
    const thrown = await ledger(model, 1.0)
      .run(stepContext(runId, resumeWorkflowId), {
        key: "x",
        model: MOCK_MODEL_ID,
        prompt: "draft",
        input,
      })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(BudgetExceeded);
    expect(model.callCount).toBe(0);
    // The refusal rolls the gate back before the re-entry write, so nothing about the row moved —
    // not its status, not its `workflow_id`, and not the flag a completed re-entry would have set.
    expect((await ledgerRows(probe, runId))[0]).toEqual(abandoned);
    expect(await spentOf()).toBe(9.5);
  }, 120_000);
});

/**
 * (c) The lock order under load: gates, completions, `reconcile()` passes and `decide()` calls all
 * contending on the same eight runs, one budget row and one ledger table. Only `40P01` and `55P03`
 * fail it — `StaleAttempt` from a `decide()` that bumped a run mid-call is the fence working, not a
 * lock-order defect, and the whole point of driving `decide()` against the gated runs is to
 * provoke it.
 */
describe("budget.test.ts (c) — the lock order under stress", () => {
  const runIds = Array.from({ length: STRESS_RUNS }, (_, i) => runIdFor(`budget-stress-${i}`));
  /** `(runId, iteration)` to the approval id decided for it, arranged up front. */
  const approvals = new Map<string, number>();

  beforeAll(async () => {
    for (const runId of runIds) await startRun(probe, flow, { n: 1 }, runId);
    // Restores the period invariant (b) broke by writing `spent_usd` by hand, so the drift
    // assertion below measures this case's own completions.
    await probe.pool.query(
      `UPDATE hf_budget_period SET budget_usd = $2,
         spent_usd = (SELECT COALESCE(SUM(cost_usd), 0) FROM hf_llm_call
                      WHERE period = $1 AND status = 'ok')
       WHERE period = $1`,
      [period, BUDGET_USD],
    );

    const { rows } = await probe.pool.query<{ id: string; run_id: string; key: string }>(
      `INSERT INTO hf_approval (run_id, key, workflow_id, type, draft, status)
       SELECT r.run_id, 'a' || i, r.run_id, 'send-email', '{"body":"draft"}'::jsonb, 'pending'
       FROM unnest($1::text[]) AS r(run_id), generate_series(0, $2::int) AS i
       RETURNING id, run_id, key`,
      [runIds, STRESS_ITERATIONS - 1],
    );
    for (const row of rows) approvals.set(`${row.run_id}/${row.key}`, Number(row.id));
  }, 180_000);

  async function currentWorkflowIds(wanted: readonly string[]): Promise<Map<string, string>> {
    const { rows } = await probe.pool.query<{ run_id: string; current_workflow_id: string }>(
      "SELECT run_id, current_workflow_id FROM hf_run WHERE run_id = ANY($1)",
      [wanted],
    );
    return new Map(rows.map((row) => [row.run_id, row.current_workflow_id]));
  }

  async function gateAndComplete(runId: string, workflowId: string, key: string): Promise<void> {
    const model = new MockLanguageModel({ responses: [{ text: key }] });
    await ledger(model, STRESS_ESTIMATE_USD).run(stepContext(runId, workflowId), {
      key,
      model: MOCK_MODEL_ID,
      prompt: "draft",
      input: { key },
    });
  }

  it(
    `survives ${STRESS_ITERATIONS} iterations with no deadlock and no lock timeout`,
    async () => {
      const failures: unknown[] = [];
      let completed = 0;

      for (let i = 0; i < STRESS_ITERATIONS; i += 1) {
        const gated = [0, 1, 2, 3].map((offset) => runIds[(i + offset) % STRESS_RUNS]!);
        // A batch spanning two runs, which is what makes `decide()` order its `hf_run` locks — and
        // two of the runs being gated, so its `hf_run FOR UPDATE` really does queue behind a gate's
        // `FOR SHARE` instead of touching rows nothing else holds.
        const toDecide = [2, 3].map((offset) => runIds[(i + offset) % STRESS_RUNS]!);
        const workflowIds = await currentWorkflowIds(gated);

        const settled = await Promise.allSettled([
          ...gated.map((runId) => gateAndComplete(runId, workflowIds.get(runId)!, `s${i}`)),
          reconcile(probe.pool, client, { applicationVersion: "stress" }),
          decide(probe.pool, client, {
            ids: toDecide.map((runId) => approvals.get(`${runId}/a${i}`)!),
            decision: "approved",
            via: "web",
            decisionKey: `stress-${i}`,
            userId: "crystal",
          }),
        ]);

        for (const outcome of settled) {
          if (outcome.status === "rejected") failures.push(outcome.reason);
          else completed += 1;
        }
      }

      expect(lockFailuresIn(failures)).toEqual([]);
      // Nothing but the fence may refuse: a `decide()` that bumped a run between its gate and its
      // completion is the design working, and any other name would mean the stress had degraded
      // into something that is no longer a lock-order test.
      expect(failures.filter((error) => (error as Error).name !== "StaleAttempt")).toEqual([]);
      // And it has to have done the work: six operations an iteration, and a run of them all
      // refused would satisfy the assertions above for the wrong reason.
      expect(completed).toBeGreaterThan(STRESS_ITERATIONS * 3);

      // The payoff of the order: every completion's spend landed on the period row exactly once.
      const { rows } = await probe.pool.query<{ spent: string; billed: string }>(
        `SELECT b.spent_usd::text AS spent,
                (SELECT COALESCE(SUM(cost_usd), 0) FROM hf_llm_call
                 WHERE period = $1 AND status = 'ok')::text AS billed
         FROM hf_budget_period b WHERE b.period = $1`,
        [period],
      );
      expect(Number(rows[0]!.spent)).toBeCloseTo(Number(rows[0]!.billed), 6);
    },
    900_000,
  );
});

/**
 * (d) Round-3 finding 8 as a regression: the gate and the completion both take `hf_budget_period`
 * before `hf_llm_call`, so two transactions on one `(run_id, key)` can only ever queue behind each
 * other. Each half holds the budget row from a connection of the test's own, lets the production
 * transaction block on it, and then takes the ledger row — the second half of the cycle the
 * inverted order made reachable. Under the inverted order that acquisition closes the cycle and
 * Postgres raises `40P01` on one of the two; under this one it is granted immediately.
 */
describe("budget.test.ts (d) — the finding-8 inversion", () => {
  const CALL = { model: MOCK_MODEL_ID, prompt: "draft", input: { a: 1 } };

  /** Takes the ledger row the production transaction has not reached, or fails fast. */
  async function lockLedgerRow(connection: Client, runId: string, key: string): Promise<void> {
    await connection.query("SET LOCAL lock_timeout = '5s'");
    await connection.query(
      "SELECT 1 FROM hf_llm_call WHERE run_id = $1 AND key = $2 FOR UPDATE",
      [runId, key],
    );
  }

  beforeAll(async () => {
    await setPeriod(BUDGET_USD, "0");
  });

  it("lets a gate blocked on the budget row be overtaken on the ledger row", async () => {
    const runId = runIdFor("budget-inversion-gate");
    await startRun(probe, flow, { n: 1 }, runId);
    // An existing row is what makes the gate's re-entry `UPDATE` — its `hf_llm_call` write — run
    // at all; a gate that only inserts never contends for the row.
    await probe.pool.query(
      `INSERT INTO hf_llm_call
         (run_id, key, workflow_id, period, input_hash, model, prompt_name, prompt_hash, status,
          estimated_cost_usd, finished_at)
       VALUES ($1, 'k', $1, $2, $3, $4, 'draft', 'abandoned-hash', 'abandoned', 0.01, now())`,
      [runId, period, hashInput(CALL.input), MOCK_MODEL_ID],
    );

    const connection = await holder();
    const failures: unknown[] = [];
    let settled = false;
    const model = new MockLanguageModel({ responses: [{ text: "re-entered" }] });
    let running: Promise<unknown> | undefined;
    try {
      await connection.query("SELECT 1 FROM hf_budget_period WHERE period = $1 FOR UPDATE", [period]);

      running = ledger(model, 0.01)
        .run(stepContext(runId, runId), { ...CALL, key: "k" })
        .catch((error: unknown) => {
          failures.push(error);
        })
        .finally(() => {
          settled = true;
        });

      await waitForBlockedBackend();
      expect(settled).toBe(false);
      expect((await ledgerRows(probe, runId))[0]).toMatchObject({ status: "abandoned" });

      await lockLedgerRow(connection, runId, "k");
      await connection.query("COMMIT");
    } finally {
      await connection.end();
    }

    await running;
    expect(lockFailuresIn(failures)).toEqual([]);
    expect(failures).toEqual([]);
    expect(model.callCount).toBe(1);
    expect((await ledgerRows(probe, runId))[0]).toMatchObject({
      status: "ok",
      possible_double_charge: true,
    });
  }, 120_000);

  it("lets a completion blocked on the budget row be overtaken on the ledger row", async () => {
    const runId = runIdFor("budget-inversion-completion");
    await startRun(probe, flow, { n: 1 }, runId);

    const connection = await holder();
    const failures: unknown[] = [];
    let settled = false;
    let opened = 0;
    const gateCommitted = deferred();
    const budgetRowHeld = deferred();

    // The only seam that reaches between the two transactions: the completion is the second one,
    // and the test has to take the budget row after the gate let go of it and before it opens.
    const ctx: LedgerContext = {
      runId,
      workflowId: runId,
      tx: async <T,>(work: (db: StepDatabase) => Promise<T>): Promise<T> => {
        const result = await steps.tx(runId, runId, work);
        opened += 1;
        if (opened === 1) {
          gateCommitted.resolve();
          await budgetRowHeld.promise;
        }
        return result;
      },
    };

    const spentBefore = await spentOf();
    const model = new MockLanguageModel({ responses: [{ text: "completed" }] });
    let running: Promise<unknown> | undefined;
    try {
      running = ledger(model, 0.02)
        .run(ctx, { ...CALL, key: "k" })
        .catch((error: unknown) => {
          failures.push(error);
        })
        .finally(() => {
          settled = true;
        });

      await gateCommitted.promise;
      await connection.query("SELECT 1 FROM hf_budget_period WHERE period = $1 FOR UPDATE", [period]);
      budgetRowHeld.resolve();

      await waitForBlockedBackend();
      expect(settled).toBe(false);
      expect((await ledgerRows(probe, runId))[0]).toMatchObject({ status: "started" });

      await lockLedgerRow(connection, runId, "k");
      await connection.query("COMMIT");
    } finally {
      await connection.end();
    }

    await running;
    expect(lockFailuresIn(failures)).toEqual([]);
    expect(failures).toEqual([]);
    expect((await ledgerRows(probe, runId))[0]).toMatchObject({ status: "ok" });
    expect(await spentOf()).toBeCloseTo(spentBefore + 0.02, 6);
  }, 120_000);
});
