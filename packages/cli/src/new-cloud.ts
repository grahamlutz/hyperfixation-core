import path from "node:path";
import { bootstrapApp } from "./bootstrap.js";
import { checklistLines } from "./checklist.js";
import { coolifyStep, providerKeys } from "./cloud-steps/coolify.js";
import { databaseStep } from "./cloud-steps/database.js";
import { deployStep, gitHeadSha } from "./cloud-steps/deploy.js";
import {
  loadOperatorConfig,
  requireOperatorConfig,
  type ConfigKey,
  type OperatorConfig,
} from "./config.js";
import { openDatabase, type AdminCredentials, type Database } from "./database.js";
import { migrateApp } from "./migrate.js";
import { deriveNames, type AppNames } from "./names.js";
import { CoolifyClient } from "./providers/coolify.js";
import type { FetchLike } from "./providers/http.js";
import { createSshRunner, type Runner } from "./runner.js";
import { statusTokenApp } from "./status-token.js";
import {
  openAppState,
  secretsHash,
  STEPS,
  type AppState,
  type AppStateStore,
  type StepName,
} from "./state.js";

/** The steps themselves; the runner is what orders and records them. */
export { CLOUD_STEPS } from "./cloud-steps/index.js";

/**
 * The steps whose "done" depends on more than having run once.
 *
 * Both carry the app's secrets into the deployment — `coolify` PATCHes them as environment
 * variables, `deploy` is what makes the containers read them — so a run that rotated a password
 * has to redo both, even though a previous run recorded them.
 */
const SECRET_CARRYING_STEPS: readonly StepName[] = ["coolify", "deploy"];

/**
 * The app's own commands, as the `coolify` step runs them through the tunnel.
 *
 * An interface rather than three direct calls because these are the three things a test cannot
 * run — each spawns the generated app's toolchain against a real database — and because the
 * `env` overlay they take is the whole point: the cloud path never reads or writes a `.env`.
 */
export interface CloudCommands {
  migrate(options: { dir: string; env: Record<string, string> }): Promise<void>;
  bootstrap(options: {
    dir: string;
    env: Record<string, string>;
    email: string;
    budgetUsd: string;
  }): Promise<void>;
  /** The plaintext of each token it generated — the only moment either exists outside a hash. */
  statusToken(options: {
    dir: string;
    env: Record<string, string>;
  }): Promise<{ read?: string; write?: string }>;
}

/** The two fields the runner itself reads; everything else on a context belongs to the steps. */
export interface StepRunContext {
  state: AppStateStore;
  /**
   * Set by the `database` step when it gave an existing role a new password.
   *
   * The deployed app still holds the old one at that moment, so the run is only safe once the
   * Coolify envs and a redeploy have followed; `assertEnvsCurrent` is what refuses to call it
   * finished before that.
   */
  rotated: boolean;
}

/** What every step of a cloud `hf new` is handed. */
export interface CloudContext extends StepRunContext {
  /** The name as typed: the directory, the Coolify project and application, the subdomain. */
  name: string;
  names: AppNames;
  /** The app's checkout on this machine — `<into>/<name>`, whether or not it exists yet. */
  dir: string;
  /** `--from`: a giget specifier or a template checkout, passed through untouched. */
  from?: string;
  /** `<name>.<HF_BASE_DOMAIN>`. */
  fqdn: string;
  /** The bootstrap admin's address and the app's starting budget; both required in the cloud. */
  email: string;
  budgetUsd: string;
  config: OperatorConfig;
  env: NodeJS.ProcessEnv;
  coolify: CoolifyClient;
  runner: Runner;
  /**
   * The box's Postgres cluster, opened on first use and shared for the rest of the run.
   *
   * One tunnel, because `database` and `coolify` both need one and a second `ssh -L` would be a
   * second thing to leak; the run closes it in a `finally`.
   */
  database(): Promise<Database>;
  commands: CloudCommands;
  /** `git rev-parse HEAD` in `dir` — the sha `deploy` waits for `/api/status` to report. */
  headSha(): Promise<string>;
  fetch: FetchLike;
  now(): number;
  sleep(ms: number): Promise<void>;
  io: { out(line: string): void };
}

export interface Step<Context extends StepRunContext = StepRunContext> {
  name: StepName;
  run(context: Context): Promise<void>;
}

export interface RunStepsResult {
  ran: readonly StepName[];
  /** Recorded by an earlier run, and still current. */
  skipped: readonly StepName[];
  /** Recorded by an earlier run, but against secrets since rotated; forgotten and run again. */
  invalidated: readonly StepName[];
}

/** The runner found state it will not act on: the operator has to be told, not worked around. */
export class StepInvariantViolated extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepInvariantViolated";
  }
}

/**
 * True when the secrets the Coolify envs were last PATCHed with are the ones the state holds now.
 *
 * A `coolify` step that has run but recorded no hash counts as stale: re-PATCHing is idempotent
 * and cheap, and the alternative is trusting a file written before this field existed.
 */
export function envsAreCurrent(state: AppState): boolean {
  return state.coolify?.envsSecretsHash === secretsHash(state);
}

/**
 * Refuses a recorded state whose deployment is authenticating with secrets that no longer exist.
 *
 * Silent otherwise, including for an app that has not reached `coolify` yet: a run that stops
 * early is resumable, whereas a `coolify` recorded against passwords since rotated is a deployed
 * app locked out of its own database with nothing left to notice it.
 */
export function assertEnvsCurrent(state: AppState): void {
  if (state.steps.coolify === undefined || envsAreCurrent(state)) return;
  throw new StepInvariantViolated(
    "the app's secrets have changed since its Coolify environment was set: re-run hf new to " +
      "PATCH the environment and redeploy (nothing was rolled back)",
  );
}

/**
 * Refuses to finish a run that rotated a password without the Coolify environment catching up.
 *
 * The state-only check above cannot see this case on its own: a list of steps that stops before
 * `coolify` leaves a consistent file and a deployed app on dead credentials.
 */
export function assertRotationApplied(context: StepRunContext): void {
  if (!context.rotated) return;
  if (context.state.isDone("coolify") && envsAreCurrent(context.state.state)) return;
  throw new StepInvariantViolated(
    "this run rotated the app's database passwords but never PATCHed them into Coolify: the " +
      "deployed app still holds the old ones. Re-run hf new to finish the rotation.",
  );
}

/**
 * Forgets the steps that carried secrets the app no longer has, and reports which.
 *
 * Done once, before the first step, and by clearing the records rather than by ignoring them:
 * `coolify` makes the hash current again the moment it re-runs, so a per-step test would then
 * count `deploy` as done and leave the containers reading the previous environment. Clearing also
 * survives a crash in between — the next run sees the same two steps missing.
 */
export async function invalidateStaleSecretSteps(
  state: AppStateStore,
): Promise<readonly StepName[]> {
  if (envsAreCurrent(state.state)) return [];

  const cleared: StepName[] = [];
  for (const name of SECRET_CARRYING_STEPS) {
    if (!state.isDone(name)) continue;
    await state.clearDone(name);
    cleared.push(name);
  }
  return cleared;
}

/**
 * Runs the steps of a cloud `hf new` in order, skipping what a previous run finished.
 *
 * A step is marked done only after its `run` resolves, so a failure leaves the step unrecorded
 * and the next run repeats it — the one direction that is safe, since repeating a create costs a
 * duplicate at worst while recording one that never happened costs an app nobody can finish.
 * Errors propagate untouched: the caller prints them, and the state file is the resume point.
 */
export async function runSteps<Context extends StepRunContext>(
  steps: readonly Step<Context>[],
  context: Context,
): Promise<RunStepsResult> {
  assertStepOrder(steps);

  const invalidated = await invalidateStaleSecretSteps(context.state);
  const ran: StepName[] = [];
  const skipped: StepName[] = [];
  for (const step of steps) {
    if (context.state.isDone(step.name)) {
      skipped.push(step.name);
      continue;
    }
    await step.run(context);
    await context.state.markDone(step.name);
    ran.push(step.name);
  }

  assertEnvsCurrent(context.state.state);
  assertRotationApplied(context);
  return { ran, skipped, invalidated };
}

/**
 * The steps of a cloud `hf new`, in `STEPS` order — which `runSteps` asserts.
 *
 * One list, so that "what does hf new do" has one answer. A step is registered here and
 * implemented under `cloud-steps/`.
 */
export const CLOUD_STEPS: readonly Step<CloudContext>[] = [
  databaseStep(),
  coolifyStep(),
  deployStep(),
];

/**
 * Every operator config key a cloud `hf new` needs, checked before the first step.
 *
 * All at once, and before anything is created: `requireOperatorConfig` names every missing key,
 * and an operator who learns about them one failed step at a time pays for a half-provisioned app
 * each time. The optional keys are deliberately absent — `HF_DB_HOST_INTERNAL` has a default, and
 * the two provider keys are what the checklist warns about when they are unset.
 */
export const REQUIRED_CLOUD_CONFIG: readonly ConfigKey[] = [
  "HF_COOLIFY_URL",
  "HF_COOLIFY_TOKEN",
  "HF_COOLIFY_SERVER_UUID",
  "HF_COOLIFY_GITHUB_APP_UUID",
  "HF_COOLIFY_POSTGRES_UUID",
  "HF_SSH_HOST",
  "HF_BASE_DOMAIN",
  "HF_SMTP_URL",
  "HF_EMAIL_FROM",
  "HF_LANGFUSE_URL",
];

/** The cluster role `hf new` provisions the app's database and roles as. */
const CLUSTER_ADMIN_USER = "postgres";

/** The real three, each under the env overlay the `coolify` step builds. */
export const cloudCommands: CloudCommands = {
  // `skipRoles`: the database step created all three, and the cloud migrator cannot create one.
  migrate: async ({ dir, env }) => {
    await migrateApp({ dir, skipRoles: true, env });
  },
  bootstrap: async ({ dir, env, email, budgetUsd }) => {
    await bootstrapApp({ dir, env, email, budgetUsd });
  },
  // `rotate`, because reaching this call at all means the state cache has no plaintext to reuse:
  // whatever hash the column holds is one nothing can authenticate against any more.
  statusToken: async ({ dir, env }) =>
    (await statusTokenApp({ dir, env, kinds: ["read", "write"], rotate: true })).tokens,
};

export interface NewAppCloudOptions {
  name: string;
  /** Required in the cloud: a deployed app never starts under a cap nobody chose. */
  budgetUsd: string;
  /** Required in the cloud: there is no prompt and no `.env` to carry it. */
  email: string;
  from?: string;
  /** Where `<name>` is created. Defaults to the working directory. */
  into?: string;
  io: { out(line: string): void };
  config?: OperatorConfig;
  env?: NodeJS.ProcessEnv;
  /** Where the per-app state files are. Defaults to `stateDir()`. */
  stateDir?: string;
  /** Replaces `CLOUD_STEPS`; the tests run a shorter list, never a different order. */
  steps?: readonly Step<CloudContext>[];
  commands?: CloudCommands;
  runner?: Runner;
  /** The cluster admin the database is provisioned as. Defaults to `postgres`/`PGPASSWORD`. */
  clusterAdmin?: AdminCredentials;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  headSha?: (dir: string) => Promise<string>;
}

export interface NewAppCloudResult extends RunStepsResult {
  dir: string;
  fqdn: string;
  /** What the operator still has to do, ready to print. */
  checklist: readonly string[];
}

/**
 * `hf new <name>` without `--local`: the ten steps, resumable, then the checklist.
 *
 * Nothing here is interactive and nothing is prompted for — this runs against five APIs and a box
 * — so every input is a flag or a config key, and a missing one is reported before the first
 * request rather than half way through.
 */
export async function newAppCloud(options: NewAppCloudOptions): Promise<NewAppCloudResult> {
  const env = options.env ?? process.env;
  const config = options.config ?? (await loadOperatorConfig({ env }));
  const required = requireOperatorConfig(config, REQUIRED_CLOUD_CONFIG, { env });

  const names = deriveNames(options.name);
  const state = await openAppState(names.given, { dir: options.stateDir, env });
  const runner = options.runner ?? createSshRunner({ host: required.HF_SSH_HOST });

  // `PGPASSWORD` is libpq's own name for it, and the same place `hf restore-check` reads it:
  // Coolify's cluster password is not an hf config key, because nothing of ours should hold it.
  const clusterAdmin: AdminCredentials =
    options.clusterAdmin ?? { user: CLUSTER_ADMIN_USER, password: env.PGPASSWORD };

  let database: Database | undefined;
  const hadWriteToken = state.state.statusTokens?.write !== undefined;

  const context: CloudContext = {
    state,
    rotated: false,
    name: names.given,
    names,
    dir: path.resolve(options.into ?? process.cwd(), names.given),
    from: options.from,
    fqdn: `${names.given}.${required.HF_BASE_DOMAIN}`,
    email: options.email,
    budgetUsd: options.budgetUsd,
    config,
    env,
    coolify: new CoolifyClient({
      url: required.HF_COOLIFY_URL,
      token: required.HF_COOLIFY_TOKEN,
      fetch: options.fetch,
    }),
    runner,
    database: async () => {
      // No `container`: the `docker exec psql` transport has no address, and every use of the
      // cluster here — `provisionRoles`, the migrator, the tokens — is a pg client.
      database ??= await openDatabase(runner, { admin: clusterAdmin });
      return database;
    },
    commands: options.commands ?? cloudCommands,
    headSha: async () => await (options.headSha ?? gitHeadSha)(context.dir),
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? (async (ms) => await new Promise((resolve) => setTimeout(resolve, ms))),
    io: options.io,
  };

  let result: RunStepsResult;
  try {
    result = await runSteps(options.steps ?? CLOUD_STEPS, context);
  } finally {
    await database?.close();
  }

  const checklist = checklistLines({
    names,
    fqdn: context.fqdn,
    repo: state.state.repo,
    dbHost: config.HF_DB_HOST_INTERNAL ?? required.HF_COOLIFY_POSTGRES_UUID,
    stateFile: state.file,
    providerKeysSent: providerKeys(config).map(([key]) => key),
    backupRegistered: state.isDone("backup"),
    // Shown once means the run that minted it; every later run leaves it in the state file alone.
    writeToken: hadWriteToken ? undefined : state.state.statusTokens?.write,
  });

  return { ...result, dir: context.dir, fqdn: context.fqdn, checklist };
}

/**
 * `STEPS`' order is the rotation-safety argument — every fallible create before `database`, and
 * `coolify` straight after it — so a caller that assembles its list in another order is a bug
 * here rather than a stranded app on the box.
 */
function assertStepOrder(steps: readonly { name: StepName }[]): void {
  const positions = steps.map((step) => STEPS.indexOf(step.name));
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index]! <= positions[index - 1]!) {
      throw new StepInvariantViolated(
        `steps out of order: ${steps[index - 1]!.name} before ${steps[index]!.name}`,
      );
    }
  }
}
