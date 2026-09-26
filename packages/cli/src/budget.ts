import { userInfo } from "node:os";
import {
  loadOperatorConfig,
  pgAdminUser,
  postgresContainers,
  requireOperatorConfig,
  type OperatorConfig,
} from "./config.js";
import { openDatabase, type AdminCredentials, type Database } from "./database.js";
import { deriveNames } from "./names.js";
import { quoteLiteral } from "./roles.js";
import { createSshRunner } from "./runner.js";

/**
 * The audit row's `action`, beside `@hyperfixation/admin`'s `app.budget_set`.
 *
 * A different name on purpose: that one edits one `hf_budget_period` row and this one edits the
 * default every period to come is created from, and an operator reading `hf_audit` has to be able
 * to tell a month's ceiling from the app's.
 */
export const BUDGET_DEFAULT_SET_ACTION = "app.budget_default_set";

/** Overrides the login name the audit row is written under. */
export const OPERATOR_ENV = "HF_OPERATOR";

export interface BudgetAppOptions {
  /** The app as `hf new` named it, which is also its database's. */
  app: string;
  /** `--usd`, as typed: validated here rather than by `parseArgs`, so the refusal can say why. */
  budgetUsd: string;
  config?: OperatorConfig;
  /** Where the cluster is reached. Defaults to the tunnel to `HF_SSH_HOST`, as `hf doctor` does. */
  database?: () => Promise<Database>;
  /** Who the audit row names. Defaults to `$HF_OPERATOR`, else this machine's login name. */
  operator?: string;
  env?: NodeJS.ProcessEnv;
}

export interface BudgetAppResult {
  app: string;
  /** As stored, so the caller prints what `numeric(12,4)` kept rather than what was typed. */
  budgetUsd: string;
  previousBudgetUsd: string;
  operator: string;
}

/** `--usd` was not a positive, finite number of dollars. Refused before the tunnel is opened. */
export class InvalidBudget extends Error {
  constructor(budgetUsd: string) {
    super(
      `--usd ${JSON.stringify(budgetUsd)} is not a budget: it must be a positive, finite number ` +
        "of dollars, the same rule hf bootstrap seeds under",
    );
    this.name = "InvalidBudget";
  }
}

/** No `hf_app_state` row to edit: nothing but `hf bootstrap` ever seeds the singleton. */
export class AppStateUnseeded extends Error {
  constructor(app: string, databaseName: string) {
    super(
      `${databaseName} has no hf_app_state row: ${app} has not been bootstrapped, and ` +
        "hf bootstrap is the only thing that seeds it",
    );
    this.name = "AppStateUnseeded";
  }
}

/**
 * `hf_app_state.budget_usd`, the audit row and the previous value, in one statement.
 *
 * One statement because both transports have to be able to carry it: a `docker exec psql` query is
 * its own session, so a `BEGIN` here and a `COMMIT` there would be two transactions and a change
 * that recorded nothing. Data-modifying CTEs run exactly once each and to completion, and `before`
 * reads the statement's own snapshot — the value as it was before `updated` wrote — so the audit
 * row and the printed line agree. An app with no `hf_app_state` row leaves `before` empty, which
 * makes the insert and the final `SELECT` no-ops; the caller says so.
 *
 * No `FOR UPDATE`, unlike the admin form's edit of one period: the row is being written by this
 * same statement, and a locking clause over a row a data-modifying CTE beside it is updating is
 * exactly the combination Postgres leaves unspecified. Two operators racing is not a case worth
 * that — each writes an audit row and the later one wins.
 */
export function setBudgetSql(budgetUsd: number, operator: string): string {
  const amount = `${quoteLiteral(String(budgetUsd))}::numeric`;
  const actor = quoteLiteral(`hf-cli:${operator}`);
  return (
    `WITH before AS (SELECT budget_usd FROM hf_app_state WHERE id = 1), ` +
    `updated AS (UPDATE hf_app_state SET budget_usd = ${amount} WHERE id = 1 ` +
    `RETURNING budget_usd), ` +
    `logged AS (INSERT INTO hf_audit (actor_id, action, target_type, target_id, meta) ` +
    `SELECT ${actor}, ${quoteLiteral(BUDGET_DEFAULT_SET_ACTION)}, 'hf_app_state', '1', ` +
    `jsonb_build_object('operator', ${quoteLiteral(operator)}, ` +
    `'previousBudgetUsd', before.budget_usd::text, 'budgetUsd', updated.budget_usd::text) ` +
    `FROM before, updated RETURNING 1) ` +
    `SELECT before.budget_usd::text, updated.budget_usd::text FROM before, updated`
  );
}

/**
 * `hf budget <name> --usd <n>` — the default every new period copies, set over the tunnel.
 *
 * The *default* and nothing else: `hf_budget_period` is untouched, so the month already running
 * keeps the ceiling it was created with. Changing that one is the admin form's job
 * (`@hyperfixation/admin`'s `setBudget`), which is passkey-gated and audited as `app.budget_set`;
 * this command is what `hf bootstrap` left with no way back, since `budget_usd` has no default and
 * the seed happens once.
 *
 * Connects as the cluster admin over the same tunnel `hf doctor` opens, because an operator
 * running this has a box and no session — and the audit row therefore names a login name rather
 * than an `hf_user`, prefixed `hf-cli:` so it cannot be mistaken for one.
 */
export async function budgetApp(options: BudgetAppOptions): Promise<BudgetAppResult> {
  const env = options.env ?? process.env;
  const names = deriveNames(options.app);

  const budgetUsd = Number(options.budgetUsd);
  if (options.budgetUsd.trim() === "" || !Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    throw new InvalidBudget(options.budgetUsd);
  }

  // An empty `HF_OPERATOR` is unset, as `loadOperatorConfig` reads every other variable: an audit
  // row whose actor is `hf-cli:` names nobody.
  const configured = env[OPERATOR_ENV];
  const operator =
    options.operator ??
    (configured === undefined || configured === "" ? userInfo().username : configured);
  const config = options.config ?? (await loadOperatorConfig({ env }));
  const open = options.database ?? defaultDatabase(config, env);

  const db = await open();
  try {
    const { rows } = await db.query(setBudgetSql(budgetUsd, operator), {
      database: names.databaseName,
    });
    const row = rows[0];
    if (row === undefined) throw new AppStateUnseeded(names.given, names.databaseName);
    return {
      app: names.given,
      previousBudgetUsd: row[0] ?? "",
      budgetUsd: row[1] ?? "",
      operator,
    };
  } finally {
    await db.close();
  }
}

/** The report as printed: what moved, and what deliberately did not. */
export function budgetLines(result: BudgetAppResult): string[] {
  return [
    `${result.app}: hf_app_state.budget_usd $${result.previousBudgetUsd} → $${result.budgetUsd}, ` +
      `audited as ${BUDGET_DEFAULT_SET_ACTION} by ${result.operator}`,
    `${result.app}: the running period keeps its own ceiling — change that in the admin budget form`,
  ];
}

function defaultDatabase(config: OperatorConfig, env: NodeJS.ProcessEnv): () => Promise<Database> {
  const { HF_SSH_HOST } = requireOperatorConfig(config, ["HF_SSH_HOST"], { env });
  const runner = createSshRunner({ host: HF_SSH_HOST });
  const admin: AdminCredentials = { user: pgAdminUser(config), password: env.PGPASSWORD };
  return async () =>
    await openDatabase(runner, { admin, containers: postgresContainers(config) });
}
