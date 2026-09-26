import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { checkE006, quoteIdent } from "@hyperfixation/db";
import { GRANT_RO_EXCLUDED_TABLES, roleNames } from "@hyperfixation/db/migrator";
import { Client } from "pg";
import {
  DEFAULT_PG_ADMIN_USER,
  loadOperatorConfig,
  pgAdminUser,
  postgresContainers,
  requireOperatorConfig,
  type OperatorConfig,
} from "./config.js";
import { openDatabase, type Database } from "./database.js";
import { deriveNames, type AppNames } from "./names.js";
import { GithubClient, type GithubPullRequest } from "./providers/github.js";
import type { FetchLike } from "./providers/http.js";
import { quoteLiteral } from "./roles.js";
import { createSshRunner, type Runner } from "./runner.js";
import { openAppState, stateDir, type AppState } from "./state.js";

/** A restore check older than this is a warning: E5 is meant to run weekly, not once. */
export const RESTORE_CHECK_MAX_AGE_DAYS = 7;

/** The `CONNECTION LIMIT` every application role is created with, in `provisionRoles`. */
export const APPLICATION_ROLE_CONNECTION_LIMIT = 25;

/** The `CONNECTION LIMIT` the `_ro` role is created with; Metabase is one reader, not an app. */
export const READONLY_ROLE_CONNECTION_LIMIT = 4;

/** The one table the `readonly` line requires: what every Metabase question is built on. */
export const READONLY_READABLE_TABLE = "hf_run";

/** Past this share of `max_connections`, the next app to deploy is the one that cannot connect. */
export const CONNECTIONS_WARN_FRACTION = 0.8;

/** The branch prefix Phase 4's core bumps open their pull requests on. */
export const CORE_BUMP_BRANCH_PREFIX = "core-bump/";

export type Severity = "ok" | "warn" | "fail";

export interface DoctorFinding {
  /** The app as the state cache names it. */
  app: string;
  /**
   * `state`, `status`, `runs`, `version`, `budget`, `E006`, `connections`, `lock`, `readonly`,
   * `restore-check`, `core-bump`.
   */
  check: string;
  severity: Severity;
  message: string;
}

export interface DoctorResult {
  findings: readonly DoctorFinding[];
  /** No warning and no failure; `hf doctor` exits 0 exactly when this is true. */
  ok: boolean;
}

/** The names E006 is read against: `SET ROLE <applicationRole>` in `<databaseName>`. */
export interface PrivilegeTarget {
  app: string;
  databaseName: string;
  applicationRole: string;
}

/** E006 for one app: resolves when both privileges are there, throws naming what is not. */
export type PrivilegeCheck = (target: PrivilegeTarget) => Promise<void>;

export interface DoctorOptions {
  /** One app; otherwise every app the state cache knows about. */
  name?: string;
  /** Defaults to `loadOperatorConfig()`. */
  config?: OperatorConfig;
  /** Where the per-app state files are. Defaults to `stateDir()`. */
  stateDir?: string;
  fetch?: FetchLike;
  /** The clock the restore-check age is measured against. */
  now?: () => Date;
  /** How E006 is read. Defaults to the tunnel to `HF_SSH_HOST` as `postgres`. */
  privileges?: PrivilegeCheck;
  /**
   * Where the connection counts and the worker locks are read: the whole cluster, as the admin
   * E006 already goes in as. Defaults to the same tunnel to `HF_SSH_HOST`.
   */
  database?: () => Promise<Database>;
  env?: NodeJS.ProcessEnv;
}

/**
 * `hf doctor` — what is wrong with the deployed apps, one line per finding.
 *
 * Every check is reported rather than thrown: an app whose status endpoint is unreachable is
 * also an app whose E006 and whose bump PRs the operator still wants to know about, and the
 * whole point of this command is one screen that says whether anything needs attention.
 *
 * Nothing here prints a secret. The read token authorizes the status request and never appears
 * in a finding, and a provider's refusal reaches a finding redacted (`ProviderError`).
 */
export async function doctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const env = options.env ?? process.env;
  const config = options.config ?? (await loadOperatorConfig({ env }));
  const required = requireOperatorConfig(config, ["HF_BASE_DOMAIN", "HF_GITHUB_TOKEN"], { env });
  const dir = options.stateDir ?? stateDir(env);

  const cluster = lazyDatabase(options.database ?? defaultDatabase(config, env));
  const context: Context = {
    dir,
    env,
    baseDomain: required.HF_BASE_DOMAIN,
    github: new GithubClient({ token: required.HF_GITHUB_TOKEN, fetch: options.fetch }),
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    now: options.now ?? (() => new Date()),
    privileges: options.privileges ?? defaultPrivilegeCheck(config, env),
    database: cluster.get,
    // One snapshot for the whole run: the counts are the box's, not any one app's, and an app
    // whose line is read a second later has not moved the cluster.
    backends: once(async () => await readBackends(await cluster.get())),
  };

  const names = options.name === undefined ? await stateNames(dir) : [options.name];
  const findings: DoctorFinding[] = [];
  try {
    for (const name of names) findings.push(...(await doctorApp(context, name)));
  } finally {
    await cluster.close();
  }

  return { findings, ok: findings.every((finding) => finding.severity === "ok") };
}

const MARKER: Record<Severity, string> = { ok: "OK  ", warn: "WARN", fail: "FAIL" };

/** The report as printed: a blank line and a header per app, then its findings. */
export function doctorLines(result: DoctorResult): string[] {
  const lines: string[] = [];
  let app: string | undefined;
  for (const finding of result.findings) {
    if (finding.app !== app) {
      if (app !== undefined) lines.push("");
      lines.push(finding.app);
      app = finding.app;
    }
    lines.push(`  ${MARKER[finding.severity]} ${finding.check}: ${finding.message}`);
  }
  if (lines.length === 0) lines.push("no apps in the state cache: hf new has provisioned none");
  return lines;
}

/**
 * E006 as the cluster admin with `SET ROLE hf_<app>`, over the tunnel a `Runner` opens.
 *
 * As the app role rather than as an admin because that is the only role whose answer matters —
 * a superuser's privileges are both true whatever the migrator granted.
 */
export function tunnelPrivilegeCheck(
  runner: Runner,
  options: { containers?: readonly string[]; adminUser?: string } = {},
): PrivilegeCheck {
  const adminUser = options.adminUser ?? DEFAULT_PG_ADMIN_USER;
  return async (target) => {
    const db = await openDatabase(runner, {
      admin: { user: adminUser },
      containers: options.containers,
    });
    try {
      const adminUrl = db.adminUrl(target.databaseName);
      if (adminUrl === undefined) {
        throw new Error(
          `E006 cannot be read over the ${db.kind} transport: ${adminUser} has to be ` +
            "a session a pg client holds open, so that SET ROLE outlives the statement",
        );
      }
      await checkAppRolePrivileges(adminUrl, target.applicationRole);
    } finally {
      await db.close();
    }
  };
}

/**
 * `@hyperfixation/db`'s own E006, run against `adminUrl` — which must already name the app's
 * database — after `SET ROLE`. The check itself is not restated here: a second copy of the
 * privilege query is a second thing to keep in step with the grants the migrator makes.
 */
export async function checkAppRolePrivileges(adminUrl: string, role: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`SET ROLE ${quoteIdent(role)}`);
    await checkE006(client);
  } finally {
    await client.end();
  }
}

interface Context {
  dir: string;
  env: NodeJS.ProcessEnv;
  baseDomain: string;
  github: GithubClient;
  fetch: FetchLike;
  now: () => Date;
  privileges: PrivilegeCheck;
  database: () => Promise<Database>;
  backends: () => Promise<Backends>;
}

function defaultPrivilegeCheck(config: OperatorConfig, env: NodeJS.ProcessEnv): PrivilegeCheck {
  const { HF_SSH_HOST } = requireOperatorConfig(config, ["HF_SSH_HOST"], { env });
  return tunnelPrivilegeCheck(createSshRunner({ host: HF_SSH_HOST }), {
    containers: postgresContainers(config),
    adminUser: pgAdminUser(config),
  });
}

function defaultDatabase(config: OperatorConfig, env: NodeJS.ProcessEnv): () => Promise<Database> {
  const { HF_SSH_HOST } = requireOperatorConfig(config, ["HF_SSH_HOST"], { env });
  const runner = createSshRunner({ host: HF_SSH_HOST });
  return async () =>
    await openDatabase(runner, {
      admin: { user: pgAdminUser(config) },
      containers: postgresContainers(config),
    });
}

/** One cluster connection for the whole run: opened when a check first needs it, closed once. */
function lazyDatabase(open: () => Promise<Database>): {
  get: () => Promise<Database>;
  close: () => Promise<void>;
} {
  let pending: Promise<Database> | undefined;
  return {
    get: () => (pending ??= open()),
    close: async () => {
      // A run whose every app failed before the first query never opened one, and an open that
      // failed is already a finding.
      await pending?.then(
        async (db) => await db.close(),
        () => undefined,
      );
    },
  };
}

function once<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= read());
}

async function doctorApp(context: Context, name: string): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  const add = (check: string, severity: Severity, message: string): void => {
    findings.push({ app: name, check, severity, message });
  };

  const file = path.join(context.dir, `${name}.json`);
  if (!(await exists(file))) {
    add("state", "fail", `no state file at ${file}: hf new has not provisioned ${name}`);
    return findings;
  }

  let state: AppState;
  try {
    state = (await openAppState(name, { dir: context.dir, env: context.env })).state;
  } catch (error) {
    add("state", "fail", flatten((error as Error).message));
    return findings;
  }

  const repo = parseRepo(state.repo);
  let mainSha: string | undefined;
  let mainShaProblem: string | undefined;
  if (repo === undefined) {
    mainShaProblem = "no owner/name repo recorded in state; main's sha cannot be read";
  } else {
    try {
      mainSha = (await context.github.getReference(repo.owner, repo.repo, "heads/main")).object.sha;
    } catch (error) {
      mainShaProblem = `${state.repo ?? "?"}: ${flatten((error as Error).message)}`;
    }
  }

  const report = await statusFindings(context, name, state, add);
  versionFinding(name, report?.applicationVersion, mainSha, mainShaProblem, add);
  if (report?.budget !== undefined) {
    budgetFinding(report.budget.current, "current", add);
    budgetFinding(report.budget.previous, "previous", add);
  }
  await privilegeFindings(context, name, add);
  // A name `deriveNames` refuses has already failed E006 on that same message; the cluster checks
  // have no names to run under and say nothing more.
  const names = tryNames(name);
  if (names !== undefined) {
    await connectionFindings(context, names.applicationRole, add);
    await lockFindings(context, names, add);
    await readonlyFindings(context, names, add);
  }
  restoreCheckFindings(context, state, add);
  if (repo !== undefined) await bumpFindings(context, repo, add);

  return findings;
}

type Add = (check: string, severity: Severity, message: string) => void;

/** The health and run lines; `undefined` when the app did not answer, which is its own line. */
async function statusFindings(
  context: Context,
  name: string,
  state: AppState,
  add: Add,
): Promise<StatusView | undefined> {
  const url = `https://${name}.${context.baseDomain}/api/status`;
  const token = state.statusTokens?.read;
  if (token === undefined) {
    add("status", "fail", `no read status token in state; hf status-token has not run for ${name}`);
    return undefined;
  }

  let report: StatusView;
  try {
    report = readStatus(await getStatus(context.fetch, url, token));
  } catch (error) {
    add("status", "fail", `GET ${url}: ${flatten((error as Error).message)}`);
    return undefined;
  }

  const anomalies = report.anomalies === undefined ? UNKNOWN : String(report.anomalies);
  add(
    "status",
    // Only a health the app actually reported can be a warning: a field it did not answer with
    // says nothing about the deployment, and a WARN the operator cannot act on is noise.
    report.health === undefined || report.health === "ok" ? "ok" : "warn",
    `health ${report.health ?? UNKNOWN}, ${anomalies} anomaly/anomalies, core ` +
      (report.coreVersion ?? UNKNOWN),
  );
  if (report.runsRunning !== undefined) {
    add("runs", "ok", `${String(report.runsRunning)} run(s) running`);
  }
  // Only `fixtures` gets a line. `live` is the expected deploy, and `unknown` — as is a core too
  // old to have the field at all — is an app that has not said; neither is a finding, but a
  // canned draft an operator takes for a real one is.
  if (report.llmMode === "fixtures") {
    add("llm", "warn", "app is serving fixture drafts — no provider key set");
  }
  return report;
}

const UNKNOWN = "unknown";

/**
 * The fields `hf doctor` reads, each as the deployed app may or may not have answered it.
 *
 * `/api/status` is shaped by the core the app runs, not by this CLI: `llm` arrived in core 0.1.1,
 * and any later field is absent from every app deployed before it. Reading one straight off the
 * response is what made a 0.1.0 app crash the whole command — including the E006, restore-check
 * and core-bump checks, which have nothing to do with the status endpoint.
 */
interface StatusView {
  health: string | undefined;
  anomalies: number | undefined;
  coreVersion: string | undefined;
  applicationVersion: string | null | undefined;
  runsRunning: number | undefined;
  llmMode: string | undefined;
  budget: { current: PeriodView | null; previous: PeriodView | null } | undefined;
}

interface PeriodView {
  period: string | undefined;
  budgetUsd: string | undefined;
  spentUsd: string | undefined;
  driftUsd: string | undefined;
}

function readStatus(payload: unknown): StatusView {
  const report = record(payload);
  const budget = record(report.budget);
  return {
    health: text(report.health),
    anomalies: numeric(report.anomalies),
    coreVersion: text(report.coreVersion),
    applicationVersion: report.applicationVersion === null ? null : text(report.applicationVersion),
    runsRunning: numeric(record(report.runs).running),
    llmMode: text(record(report.llm).mode),
    budget: isRecord(report.budget)
      ? { current: readPeriod(budget.current), previous: readPeriod(budget.previous) }
      : undefined,
  };
}

/** `null` for a period the app has no row for, which is also how a malformed one reads. */
function readPeriod(value: unknown): PeriodView | null {
  if (!isRecord(value)) return null;
  return {
    period: text(value.period),
    budgetUsd: text(value.budgetUsd),
    spentUsd: text(value.spentUsd),
    driftUsd: text(value.driftUsd),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A money column as a number, or `undefined` when the app did not report a usable one. */
function amount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * What the app answers against what its repository's main holds.
 *
 * The mismatch names `hf deploy` because nothing else closes it: Coolify's push auto-deploy is
 * disabled on every application `hf new` creates, so a merged pull request sits unpublished until
 * an operator says so.
 */
function versionFinding(
  name: string,
  deployed: string | null | undefined,
  mainSha: string | undefined,
  mainShaProblem: string | undefined,
  add: Add,
): void {
  if (mainShaProblem !== undefined) {
    add("version", "fail", mainShaProblem);
    return;
  }
  if (deployed === undefined || mainSha === undefined) return;
  if (deployed === null) {
    add("version", "warn", "the app reports no applicationVersion: HF_BUILD_SHA is unset");
    return;
  }
  add(
    "version",
    deployed === mainSha ? "ok" : "warn",
    deployed === mainSha
      ? `applicationVersion ${short(mainSha)} is main`
      : `applicationVersion ${short(deployed)} is not main ${short(mainSha)} — run hf deploy ${name}`,
  );
}

function budgetFinding(period: PeriodView | null, which: string, add: Add): void {
  if (period === null) {
    add("budget", "ok", `no ${which} period row yet`);
    return;
  }
  const spent = amount(period.spentUsd);
  const budget = amount(period.budgetUsd);
  const drift = amount(period.driftUsd);
  const over = spent !== undefined && budget !== undefined && spent > budget;
  const drifting = drift !== undefined && drift !== 0;
  const spend =
    `${period.period ?? UNKNOWN} spent $${period.spentUsd ?? UNKNOWN} ` +
    `of $${period.budgetUsd ?? UNKNOWN}`;
  if (over || drifting) {
    add(
      "budget",
      "warn",
      `${spend}${over ? " — over budget" : ""}${drifting ? ` — drift $${period.driftUsd}` : ""}`,
    );
    return;
  }
  add("budget", "ok", `${spend}, no drift`);
}

async function privilegeFindings(context: Context, name: string, add: Add): Promise<void> {
  let target: PrivilegeTarget;
  try {
    const names = deriveNames(name);
    target = {
      app: name,
      databaseName: names.databaseName,
      applicationRole: names.applicationRole,
    };
  } catch (error) {
    add("E006", "fail", flatten((error as Error).message));
    return;
  }

  try {
    await context.privileges(target);
    add(
      "E006",
      "ok",
      `${target.applicationRole} has USAGE on dbos and INSERT on dbos.workflow_status`,
    );
  } catch (error) {
    add("E006", "fail", flatten((error as Error).message));
  }
}

/** Every backend belonging to an app role — `hf_<app>` and its `_migrator` and `_ro`. */
const BACKENDS_SQL =
  "SELECT usename, count(*) FROM pg_stat_activity WHERE usename LIKE 'hf\\_%' GROUP BY usename";

interface Backends {
  /** `max_connections`, or `undefined` when the server answered with something else. */
  max: number | undefined;
  total: number;
  byRole: Map<string, number>;
}

async function readBackends(db: Database): Promise<Backends> {
  const setting = (await db.query("SHOW max_connections")).rows[0]?.[0];
  const byRole = new Map<string, number>();
  for (const row of (await db.query(BACKENDS_SQL)).rows) {
    if (row[0] !== undefined) byRole.set(row[0], Number(row[1]));
  }
  let total = 0;
  for (const count of byRole.values()) total += count;
  return { max: setting === undefined ? undefined : numeric(Number(setting)), total, byRole };
}

/**
 * What the box's connection slots are spent on, and what this app has of them.
 *
 * Box-wide rather than per-app because that is where it runs out: every app on the box draws on
 * one `max_connections`, and the app that then cannot connect is whichever one deploys next.
 */
async function connectionFindings(context: Context, role: string, add: Add): Promise<void> {
  let backends: Backends;
  try {
    backends = await context.backends();
  } catch (error) {
    add("connections", "fail", flatten((error as Error).message));
    return;
  }

  const limit = String(APPLICATION_ROLE_CONNECTION_LIMIT);
  const line =
    `${role} ${String(backends.byRole.get(role) ?? 0)}/${limit}, box ` +
    `${String(backends.total)}/${backends.max === undefined ? UNKNOWN : String(backends.max)} ` +
    "on hf_ roles";
  const crowded =
    backends.max !== undefined && backends.total > backends.max * CONNECTIONS_WARN_FRACTION;
  add(
    "connections",
    crowded ? "warn" : "ok",
    crowded
      ? `${line} — over ${String(CONNECTIONS_WARN_FRACTION * 100)}% of max_connections`
      : line,
  );
}

/**
 * The worker's advisory lock in one app's database: exactly one, under the key the worker takes.
 *
 * `pg_try_advisory_lock(bigint)` splits its key across `classid` and `objid`, so the key is
 * reassembled rather than compared whole — and masked rather than only shifted, because
 * `hashtext` answers `int4` and a negative hash widens to a bigint of sign bits.
 *
 * Two counts, and only the second decides: an app's database holds advisory locks that are not
 * the worker's — `fetch.get` takes one per host for the length of a request — so the total is
 * diagnostic colour, never a verdict.
 */
export function workerLockSql(appName: string): string {
  return (
    `WITH k AS (SELECT hashtext('hf-worker:' || ${quoteLiteral(appName)})::bigint AS value) ` +
    "SELECT count(l.pid), count(l.pid) FILTER (WHERE " +
    "l.classid = ((k.value >> 32) & 4294967295)::oid AND " +
    "l.objid = (k.value & 4294967295)::oid) " +
    "FROM k LEFT JOIN pg_locks AS l ON l.locktype = 'advisory' AND " +
    "l.database = (SELECT oid FROM pg_database WHERE datname = current_database())"
  );
}

async function lockFindings(context: Context, names: AppNames, add: Add): Promise<void> {
  let row: string[] | undefined;
  try {
    const db = await context.database();
    row = (await db.query(workerLockSql(names.appName), { database: names.databaseName })).rows[0];
  } catch (error) {
    add("lock", "fail", flatten((error as Error).message));
    return;
  }

  const key = `hf-worker:${names.appName}`;
  const held = Number(row?.[0]);
  const matching = Number(row?.[1]);
  if (!Number.isFinite(matching)) {
    add("lock", "fail", `pg_locks in ${names.databaseName} answered no count`);
    return;
  }
  if (matching === 0) {
    add(
      "lock",
      "fail",
      held > 0
        ? `no advisory lock in ${names.databaseName} carries hashtext('${key}'): ` +
            `${String(held)} held, none the worker's`
        : `no advisory lock in ${names.databaseName}: no worker holds ${key}`,
    );
    return;
  }
  if (matching !== 1) {
    add(
      "lock",
      "fail",
      `${String(matching)} advisory locks on ${key} in ${names.databaseName}; ` +
        "one worker per app holds one",
    );
    return;
  }
  add("lock", "ok", `one worker holds ${key} in ${names.databaseName}`);
}

/**
 * What the `_ro` role may read in one app's database, and what limit it was created with.
 *
 * One row per table: `yes`, `no`, or `absent` for a table the database does not have — a state of
 * its own, because a `hf_run` nobody can read and a `hf_run` that is not there are different
 * problems. No row at all is a role the cluster does not have, which is Metabase not installed.
 *
 * Text rather than booleans and a `LEFT JOIN` rather than `has_table_privilege(name, name)`
 * because both transports hand every value back as a string, and the two-argument form errors on
 * a table that is missing instead of answering about it.
 */
export function readonlyGrantsSql(role: string): string {
  const tables = [READONLY_READABLE_TABLE, ...GRANT_RO_EXCLUDED_TABLES]
    .map((table) => `(${quoteLiteral(table)})`)
    .join(", ");
  return (
    "SELECT r.rolconnlimit, t.name, CASE WHEN c.oid IS NULL THEN 'absent' " +
    "WHEN has_table_privilege(r.oid, c.oid, 'SELECT') THEN 'yes' ELSE 'no' END " +
    `FROM pg_roles AS r CROSS JOIN (VALUES ${tables}) AS t(name) ` +
    "LEFT JOIN pg_class AS c ON c.relname = t.name AND c.relnamespace = 'public'::regnamespace " +
    `WHERE r.rolname = ${quoteLiteral(role)} ORDER BY t.name`
  );
}

/**
 * The role Metabase reads through: that it exists, that it reads `hf_run`, and that it reads none
 * of the auth tables `grantReadOnly` revokes.
 *
 * An absent role is a warning rather than a failure — Metabase is optional per deployment, and
 * `hf new` creates the role only when a password was supplied. Anything else is a failure: a
 * reader that can see `hf_user` is a reader that can work towards a staff session.
 */
async function readonlyFindings(context: Context, names: AppNames, add: Add): Promise<void> {
  const role = roleNames(names.appName).readonly;
  let rows: string[][];
  try {
    const db = await context.database();
    rows = (await db.query(readonlyGrantsSql(role), { database: names.databaseName })).rows;
  } catch (error) {
    add("readonly", "fail", flatten((error as Error).message));
    return;
  }

  if (rows.length === 0) {
    add("readonly", "warn", `no ${role} role on the cluster: no Metabase reads ${names.databaseName}`);
    return;
  }

  const privileges = new Map(rows.map((row) => [row[1] ?? "", row[2] ?? ""]));
  const limit = Number(rows[0]?.[0]);
  const problems: string[] = [];

  const run = privileges.get(READONLY_READABLE_TABLE);
  if (run === "absent") {
    problems.push(`no ${READONLY_READABLE_TABLE} in ${names.databaseName}: hf migrate has not run`);
  } else if (run !== "yes") {
    problems.push(`${role} cannot read ${READONLY_READABLE_TABLE} — rerun hf migrate`);
  }

  const readable = GRANT_RO_EXCLUDED_TABLES.filter((table) => privileges.get(table) === "yes");
  if (readable.length > 0) {
    problems.push(`${role} can read ${readable.join(", ")} — rerun hf migrate`);
  }
  if (limit !== READONLY_ROLE_CONNECTION_LIMIT) {
    problems.push(
      `connection limit is ${Number.isFinite(limit) ? String(limit) : UNKNOWN}, not ` +
        String(READONLY_ROLE_CONNECTION_LIMIT),
    );
  }

  if (problems.length > 0) {
    add("readonly", "fail", problems.join("; "));
    return;
  }
  add(
    "readonly",
    "ok",
    `${role} reads ${READONLY_READABLE_TABLE}, none of the ` +
      `${String(GRANT_RO_EXCLUDED_TABLES.length)} auth tables, connection limit ${String(limit)}`,
  );
}

function tryNames(name: string): AppNames | undefined {
  try {
    return deriveNames(name);
  } catch {
    return undefined;
  }
}

function restoreCheckFindings(context: Context, state: AppState, add: Add): void {
  const last = state.lastRestoreCheckAt;
  if (last === undefined) {
    add("restore-check", "warn", "never run; run hf restore-check");
    return;
  }
  const at = Date.parse(last);
  if (Number.isNaN(at)) {
    add("restore-check", "warn", `lastRestoreCheckAt is not a date: ${last}`);
    return;
  }
  const days = (context.now().getTime() - at) / 86_400_000;
  add(
    "restore-check",
    days > RESTORE_CHECK_MAX_AGE_DAYS ? "warn" : "ok",
    `last ran ${days.toFixed(1)} day(s) ago (${last})`,
  );
}

async function bumpFindings(
  context: Context,
  repo: { owner: string; repo: string },
  add: Add,
): Promise<void> {
  let open: GithubPullRequest[];
  try {
    open = await context.github.listPullRequests(repo.owner, repo.repo, {
      state: "open",
      per_page: 100,
    });
  } catch (error) {
    add("core-bump", "fail", flatten((error as Error).message));
    return;
  }

  const bumps = open.filter((pull) => pull.head.ref.startsWith(CORE_BUMP_BRANCH_PREFIX));
  if (bumps.length === 0) {
    add("core-bump", "ok", "no open core-bump pull request");
    return;
  }
  for (const pull of bumps) {
    let checks: string;
    try {
      checks = (await context.github.getCombinedStatus(repo.owner, repo.repo, pull.head.sha)).state;
    } catch (error) {
      add("core-bump", "fail", `#${String(pull.number)}: ${flatten((error as Error).message)}`);
      continue;
    }
    add(
      "core-bump",
      checks === "failure" ? "warn" : "ok",
      `#${String(pull.number)} ${pull.head.ref}: checks ${checks} — ${pull.html_url}`,
    );
  }
}

/**
 * The status request, and nothing of the response body on a refusal: `/api/status` answers 401
 * with a body of its own, and everything it would say about the token belongs nowhere near a
 * terminal.
 */
async function getStatus(fetchImpl: FetchLike, url: string, token: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return await response.json();
}

async function stateNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .sort();
}

function parseRepo(repo: string | undefined): { owner: string; repo: string } | undefined {
  const parts = repo?.split("/") ?? [];
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return undefined;
  return { owner: parts[0]!, repo: parts[1]! };
}

async function exists(file: string): Promise<boolean> {
  return await access(file).then(
    () => true,
    () => false,
  );
}

/** One finding is one line, and `BootCheckFailure` spells its details across several. */
function flatten(message: string): string {
  return message.replace(/\s*\n\s*-?\s*/g, "; ").trim();
}

function short(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}
