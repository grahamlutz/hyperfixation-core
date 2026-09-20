import path from "node:path";
import { checklistLines } from "./checklist.js";
import { providerKeys } from "./cloud-steps/coolify.js";
import {
  cloudCommands,
  CLOUD_STEPS,
  defaultTemplateFetch,
  spawnStepExec,
  type CloudCommands,
  type CloudStepContext,
} from "./cloud-steps/index.js";
import {
  CONFIG_KEYS,
  loadOperatorConfig,
  requireOperatorConfig,
  type ConfigKey,
  type OperatorConfig,
} from "./config.js";
import { openDatabase, type AdminCredentials, type Database } from "./database.js";
import { deriveNames } from "./names.js";
import type { FetchLike } from "./providers/http.js";
import { createSshRunner, type Runner } from "./runner.js";
import {
  openAppState,
  secretsHash,
  STEPS,
  type AppState,
  type AppStateStore,
  type StepName,
} from "./state.js";

/** The steps themselves; the runner is what orders and records them. */
export { CLOUD_STEPS };

/**
 * The steps whose "done" depends on more than having run once.
 *
 * Both carry the app's secrets into the deployment — `coolify` PATCHes them as environment
 * variables, `deploy` is what makes the containers read them — so a run that rotated a password
 * has to redo both, even though a previous run recorded them.
 */
const SECRET_CARRYING_STEPS: readonly StepName[] = ["coolify", "deploy"];

/**
 * What the runner itself is handed. The steps get `CloudStepContext`, which extends it.
 */
export interface CloudContext {
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

export interface Step<Context extends CloudContext = CloudContext> {
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
export function assertRotationApplied(context: CloudContext): void {
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
export async function runSteps<Context extends CloudContext>(
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
 * The keys a cloud `hf new` runs without: `HF_DB_HOST_INTERNAL` has a default, the two provider
 * keys are what the checklist warns about when they are unset, and the three Langfuse keys are
 * three ways of configuring one step — an org key, a project key pair, or neither, which the step
 * degrades to a warning and a checklist line.
 */
export const OPTIONAL_CLOUD_CONFIG: readonly ConfigKey[] = [
  "HF_DB_HOST_INTERNAL",
  "HF_ANTHROPIC_API_KEY",
  "HF_OPENAI_API_KEY",
  "HF_LANGFUSE_ORG_KEY",
  "HF_LANGFUSE_PUBLIC_KEY",
  "HF_LANGFUSE_SECRET_KEY",
];

/**
 * Every operator config key a cloud `hf new` needs, checked before the first step.
 *
 * All at once, and before anything is created: `requireOperatorConfig` names every missing key,
 * and an operator who learns about them one failed step at a time pays for a half-provisioned app
 * each time. Derived from `CONFIG_KEYS` rather than listed, because a hand-kept list is exactly
 * what left `HF_GITHUB_TOKEN`, the Cloudflare pair and five others to fail at their own step: the
 * ten steps between them read every key there is, so the required set is the complement of the
 * optional one, and a key added for a step is required the moment it is named.
 */
export const REQUIRED_CLOUD_CONFIG: readonly ConfigKey[] = CONFIG_KEYS.filter(
  (key) => !OPTIONAL_CLOUD_CONFIG.includes(key),
);

/** The cluster role `hf new` provisions the app's database and roles as. */
const CLUSTER_ADMIN_USER = "postgres";

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
  steps?: readonly Step<CloudStepContext>[];
  commands?: CloudCommands;
  runner?: Runner;
  /** The cluster admin the database is provisioned as. Defaults to `postgres`/`PGPASSWORD`. */
  clusterAdmin?: AdminCredentials;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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

  const fqdn = `${names.given}.${required.HF_BASE_DOMAIN}`;
  const context: CloudStepContext = {
    state,
    rotated: false,
    names,
    dir: path.resolve(options.into ?? process.cwd(), names.given),
    config,
    env,
    io: options.io,
    checklist: [],
    exec: spawnStepExec,
    from: options.from,
    fetchTemplate: defaultTemplateFetch,
    fetch: options.fetch,
    email: options.email,
    budgetUsd: options.budgetUsd,
    database: async () => {
      // No `container`: the `docker exec psql` transport has no address, and every use of the
      // cluster here — `provisionRoles`, the migrator, the tokens — is a pg client.
      database ??= await openDatabase(runner, { admin: clusterAdmin });
      return database;
    },
    commands: options.commands ?? cloudCommands,
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? (async (ms) => await new Promise((resolve) => setTimeout(resolve, ms))),
  };

  let result: RunStepsResult;
  try {
    result = await runSteps(options.steps ?? CLOUD_STEPS, context);
  } finally {
    await database?.close();
  }

  const checklist = checklistLines({
    names,
    fqdn,
    repo: state.state.repo,
    dbHost: config.HF_DB_HOST_INTERNAL ?? required.HF_COOLIFY_POSTGRES_UUID,
    stateFile: state.file,
    providerKeysSent: providerKeys(config).map(([key]) => key),
    // Whatever the steps themselves asked the operator to look at — the backup schedule included,
    // which is the one thing Coolify's API cannot be asked about.
    fromSteps: context.checklist,
    // Shown once means the run that minted it; every later run leaves it in the state file alone.
    writeToken: hadWriteToken ? undefined : state.state.statusTokens?.write,
  });

  return { ...result, dir: context.dir, fqdn, checklist };
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
