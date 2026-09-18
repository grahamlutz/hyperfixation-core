/**
 * What the three redeploy cases need from the database and the control plane.
 *
 * Every read goes through one pooled probe rather than a connection per call: a status poll runs
 * ten times a second for as long as a case waits, and a fresh TCP connection each time exhausts
 * the host's ephemeral ports long before the cases are done with it.
 *
 * The reservation query here is deliberately a copy of the gate's, not a shared helper: a test
 * that asserted "the reservation is 0" by calling the code under test would assert nothing.
 */
import { asRole, type TestDatabase } from "@hyperfixation/testing";
import { getClient, runsStart, type Flow, type StartedRun } from "@hyperfixation/workflows";
import { Pool } from "pg";
import { PROVIDER_CALL_MARKER } from "./llm-flow.js";

export const PROBE_POOL_SIZE = 4;

export interface LedgerProbe {
  database: TestDatabase;
  /** Unfenced, like the control pool: this is a test's own handle, not a step's. */
  pool: Pool;
  close(): Promise<void>;
}

export interface LedgerRow {
  key: string;
  status: string;
  workflow_id: string;
  period: string;
  possible_double_charge: boolean;
  cost_usd: string | null;
  estimated_cost_usd: string;
  finished_at: Date | null;
}

export interface RunRow {
  status: string;
  attempt: number;
  current_workflow_id: string;
  error: string | null;
}

export function ledgerProbe(database: TestDatabase): LedgerProbe {
  const pool = new Pool({ max: PROBE_POOL_SIZE, connectionString: database.applicationUrl });
  return { database, pool, close: () => pool.end() };
}

export async function seedAppState(database: TestDatabase, budgetUsd: string): Promise<void> {
  await asRole(database.migratorUrl, async (pg) => {
    await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, $1)", [
      budgetUsd,
    ]);
  });
}

export async function ledgerRows(probe: LedgerProbe, runId: string): Promise<LedgerRow[]> {
  const { rows } = await probe.pool.query<LedgerRow>(
    "SELECT key, status, workflow_id, period, possible_double_charge, cost_usd, " +
      "estimated_cost_usd, finished_at FROM hf_llm_call WHERE run_id = $1 ORDER BY key",
    [runId],
  );
  return rows;
}

export async function currentPeriod(probe: LedgerProbe): Promise<string> {
  const { rows } = await probe.pool.query<{ period: string }>(
    "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') AS period",
  );
  return rows[0]!.period;
}

export async function derivedReservation(probe: LedgerProbe, period: string): Promise<string> {
  const { rows } = await probe.pool.query<{ reserved: string }>(
    `SELECT COALESCE(SUM(l.estimated_cost_usd), 0)::text AS reserved
     FROM hf_llm_call l
     JOIN hf_run r ON r.run_id = l.run_id
     WHERE l.status = 'started' AND l.period = $1
       AND l.workflow_id = r.current_workflow_id AND r.status = 'running'`,
    [period],
  );
  return rows[0]!.reserved;
}

export async function budgetPeriod(
  probe: LedgerProbe,
  period: string,
): Promise<{ budget_usd: string; spent_usd: string } | undefined> {
  const { rows } = await probe.pool.query<{ budget_usd: string; spent_usd: string }>(
    "SELECT budget_usd, spent_usd FROM hf_budget_period WHERE period = $1",
    [period],
  );
  return rows[0];
}

export async function runRow(probe: LedgerProbe, runId: string): Promise<RunRow | undefined> {
  const { rows } = await probe.pool.query<RunRow>(
    "SELECT status, attempt, current_workflow_id, error FROM hf_run WHERE run_id = $1",
    [runId],
  );
  return rows[0];
}

export async function waitForStatus(
  probe: LedgerProbe,
  runId: string,
  status: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await runRow(probe, runId);
    if (row?.status === status) return;
    if (Date.now() > deadline) {
      throw new Error(`hf_run ${runId} never reached ${status} (still ${row?.status ?? "absent"})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** One provider call per marker line, whichever worker printed it. */
export function providerCalls(output: string): number {
  return output.split("\n").filter((line) => line.includes(PROVIDER_CALL_MARKER)).length;
}

export async function startRun<I>(
  probe: LedgerProbe,
  flow: Flow<I, unknown>,
  input: I,
  runId: string,
): Promise<StartedRun> {
  const client = await getClient({
    appName: probe.database.appName,
    databaseUrl: probe.database.applicationUrl,
  });
  return runsStart(probe.pool, client, flow, input, { runId });
}
