import { secretsHash, STEPS, type AppState, type AppStateStore, type StepName } from "./state.js";

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

/** What every step of a cloud `hf new` is handed; PRs 2 and 3 widen it with clients and config. */
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
 * `STEPS`' order is the rotation-safety argument — every fallible create before `database`, and
 * `coolify` straight after it — so a caller that assembles its list in another order is a bug
 * here rather than a stranded app on the box.
 */
function assertStepOrder(steps: readonly Step<CloudContext>[]): void {
  const positions = steps.map((step) => STEPS.indexOf(step.name));
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index]! <= positions[index - 1]!) {
      throw new StepInvariantViolated(
        `steps out of order: ${steps[index - 1]!.name} before ${steps[index]!.name}`,
      );
    }
  }
}
