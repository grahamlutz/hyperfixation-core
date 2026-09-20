import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { checkE006, quoteIdent } from "@hyperfixation/db";
import { Client } from "pg";
import {
  DEFAULT_PG_ADMIN_USER,
  loadOperatorConfig,
  pgAdminUser,
  postgresContainers,
  requireOperatorConfig,
  type OperatorConfig,
} from "./config.js";
import { openDatabase } from "./database.js";
import { deriveNames } from "./names.js";
import { GithubClient, type GithubPullRequest } from "./providers/github.js";
import type { FetchLike } from "./providers/http.js";
import { createSshRunner, type Runner } from "./runner.js";
import { openAppState, stateDir, type AppState } from "./state.js";

/** A restore check older than this is a warning: E5 is meant to run weekly, not once. */
export const RESTORE_CHECK_MAX_AGE_DAYS = 7;

/** The branch prefix Phase 4's core bumps open their pull requests on. */
export const CORE_BUMP_BRANCH_PREFIX = "core-bump/";

export type Severity = "ok" | "warn" | "fail";

export interface DoctorFinding {
  /** The app as the state cache names it. */
  app: string;
  /** `state`, `status`, `runs`, `version`, `budget`, `E006`, `restore-check`, `core-bump`. */
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
 * in a finding; a provider's response body is dropped for the same reason (`ProviderError`).
 */
export async function doctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const env = options.env ?? process.env;
  const config = options.config ?? (await loadOperatorConfig({ env }));
  const required = requireOperatorConfig(config, ["HF_BASE_DOMAIN", "HF_GITHUB_TOKEN"], { env });
  const dir = options.stateDir ?? stateDir(env);

  const context: Context = {
    dir,
    env,
    baseDomain: required.HF_BASE_DOMAIN,
    github: new GithubClient({ token: required.HF_GITHUB_TOKEN, fetch: options.fetch }),
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    now: options.now ?? (() => new Date()),
    privileges: options.privileges ?? defaultPrivilegeCheck(config, env),
  };

  const names = options.name === undefined ? await stateNames(dir) : [options.name];
  const findings: DoctorFinding[] = [];
  for (const name of names) findings.push(...(await doctorApp(context, name)));

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
}

function defaultPrivilegeCheck(config: OperatorConfig, env: NodeJS.ProcessEnv): PrivilegeCheck {
  const { HF_SSH_HOST } = requireOperatorConfig(config, ["HF_SSH_HOST"], { env });
  return tunnelPrivilegeCheck(createSshRunner({ host: HF_SSH_HOST }), {
    containers: postgresContainers(config),
    adminUser: pgAdminUser(config),
  });
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
  versionFinding(report?.applicationVersion, mainSha, mainShaProblem, add);
  if (report?.budget !== undefined) {
    budgetFinding(report.budget.current, "current", add);
    budgetFinding(report.budget.previous, "previous", add);
  }
  await privilegeFindings(context, name, add);
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

function versionFinding(
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
      : `applicationVersion ${short(deployed)} is not main ${short(mainSha)}`,
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
