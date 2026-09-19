import { ADMIN_ROLE, type RequireSession } from "@hyperfixation/auth";
import type { Pool } from "pg";

/** The audit row's `action`, alongside `app.pause` and `app.resume`. */
export const BUDGET_SET_OPERATION = "app.budget_set";

/** One line per change; the next gate's refusal will be asked about. */
export const BUDGET_SET_MARKER = "hf-admin: budget set";

/**
 * The same row the gate locks, in the same order — this takes only that one lock, so it cannot
 * deadlock against a gate holding `hf_run` first.
 */
const UPDATE_STATEMENT =
  "WITH before AS (SELECT period, budget_usd FROM hf_budget_period WHERE period = $1 FOR UPDATE) " +
  "UPDATE hf_budget_period b SET budget_usd = $2::numeric FROM before " +
  "WHERE b.period = before.period " +
  "RETURNING before.budget_usd::text AS previous, b.budget_usd::text AS budget, " +
  "b.spent_usd::text AS spent";

const AUDIT_STATEMENT =
  "INSERT INTO hf_audit (actor_id, action, target_type, target_id, meta) " +
  `VALUES ($1, '${BUDGET_SET_OPERATION}', 'hf_budget_period', $2, $3::jsonb)`;

/** A budget that is not a finite, non-negative number. Refused before any lock is taken. */
export class InvalidBudget extends Error {
  readonly period: string;
  readonly budgetUsd: number;

  constructor(period: string, budgetUsd: number) {
    super(
      `InvalidBudget: ${JSON.stringify(budgetUsd)} is not a budget for ${period}; ` +
        "it must be a finite, non-negative number of dollars",
    );
    this.name = "InvalidBudget";
    this.period = period;
    this.budgetUsd = budgetUsd;
  }
}

/** No row for that period yet. The first gate of a month creates it; nothing else does. */
export class UnknownBudgetPeriod extends Error {
  readonly period: string;

  constructor(period: string) {
    super(
      `UnknownBudgetPeriod: hf_budget_period has no row for ${period}; the first gate of a ` +
        "period creates it from hf_app_state.budget_usd",
    );
    this.name = "UnknownBudgetPeriod";
    this.period = period;
  }
}

export interface SetBudgetOptions {
  /** The `YYYY-MM` primary key. Only this row is touched. */
  period: string;
  budgetUsd: number;
  /** The admin who did it. Null only for a change driven from outside a session. */
  actorId?: string | null;
  reason?: string;
}

export interface SetBudgetResult {
  period: string;
  /** As stored, so a caller sees what `numeric(12,4)` kept rather than what it asked for. */
  budgetUsd: string;
  previousBudgetUsd: string;
  spentUsd: string;
}

/**
 * Sets one period's ceiling. The next gate reads it: nothing caches the budget, so the change
 * lands on the next `llm.run` and not on any call already past its gate.
 *
 * A budget **below** what the period has already spent is allowed. It is not a correction but
 * the kill-lever: the next gate compares `spent + reserved + estimate > budget` and refuses
 * every further call for the period, which is what an admin watching a runaway month wants.
 * `spent_usd` is never touched — the money is spent either way.
 *
 * `hf_app_state.budget_usd` is not touched either: that is only the default copied into each
 * new period, so editing it here would silently change every month to come.
 */
export async function setBudget(
  pool: Pool,
  options: SetBudgetOptions,
): Promise<SetBudgetResult> {
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd < 0) {
    throw new InvalidBudget(options.period, options.budgetUsd);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<{ previous: string; budget: string; spent: string }>(
      UPDATE_STATEMENT,
      [options.period, options.budgetUsd],
    );
    const row = updated.rows[0];
    if (row === undefined) throw new UnknownBudgetPeriod(options.period);

    await client.query(AUDIT_STATEMENT, [
      options.actorId ?? null,
      options.period,
      JSON.stringify({
        previousBudgetUsd: row.previous,
        budgetUsd: row.budget,
        spentUsd: row.spent,
        reason: options.reason ?? null,
      }),
    ]);
    await client.query("COMMIT");

    const result: SetBudgetResult = {
      period: options.period,
      budgetUsd: row.budget,
      previousBudgetUsd: row.previous,
      spentUsd: row.spent,
    };
    console.info(BUDGET_SET_MARKER, JSON.stringify(result));
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface SetBudgetActionOptions {
  pool: Pool;
  requireSession: RequireSession;
}

export type SetBudgetAction = (options: SetBudgetOptions) => Promise<SetBudgetResult>;

/**
 * The admin action, guarded like `resetSecondFactor` and taking its actor from the guarded
 * session rather than from whatever the form said.
 */
export function createSetBudgetAction(options: SetBudgetActionOptions): SetBudgetAction {
  return async (set: SetBudgetOptions): Promise<SetBudgetResult> => {
    const session = await options.requireSession({ factor: "passkey", role: ADMIN_ROLE });
    return setBudget(options.pool, { ...set, actorId: session.user.id });
  };
}
