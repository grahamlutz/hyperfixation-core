import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { configHome } from "./config.js";
import { readSecretFile, writeSecretFile } from "./secret-file.js";

/**
 * The ten steps of a cloud `hf new`, in the order it runs them. A step is recorded only once
 * everything it created is in the state file, so a rerun resumes at the first unrecorded step
 * rather than re-creating what the previous run already paid for.
 *
 * `database` sits immediately before `coolify` because it is the one step that *rotates*: a cold
 * run gives the roles new passwords, and a deployed app keeps the old ones until the envs are
 * PATCHed and the app redeployed. Every fallible external create — the repo, the backup, Sentry,
 * Langfuse, the DNS record — therefore happens first, so a failure in one of them cannot leave a
 * live app holding credentials nothing will replace.
 */
export const STEPS = [
  "template",
  "install",
  "repo",
  "backup",
  "sentry",
  "langfuse",
  "dns",
  "database",
  "coolify",
  "deploy",
] as const;

export type StepName = (typeof STEPS)[number];

export interface StepRecord {
  /** ISO 8601, when the step finished. */
  doneAt: string;
}

export interface CoolifyState {
  projectUuid?: string;
  appUuid?: string;
  /**
   * `secretsHash` of the secrets the last bulk env PATCH carried.
   *
   * The `coolify` step is "done" only while this matches what the state holds now: a cold run
   * that rotated the role passwords leaves the deployed app authenticating with the old ones, and
   * a recorded `steps.coolify` would otherwise make a rerun skip the one PATCH that fixes it.
   */
  envsSecretsHash?: string;
}

/** The three role passwords a cold run generates. Nothing else on the laptop has a copy. */
export interface DatabaseState {
  migratorPassword?: string;
  applicationPassword?: string;
  readonlyPassword?: string;
}

export interface LangfuseState {
  publicKey?: string;
  secretKey?: string;
}

export interface StatusTokenState {
  read?: string;
  write?: string;
}

/**
 * Everything one cloud app's provisioning produced, so that a rerun, `hf doctor` and
 * `hf restore-check` do not have to ask five APIs what already exists.
 *
 * Every field is optional but `steps`: the file is written between steps, and each step fills
 * in its own part.
 */
export interface AppState {
  steps: Partial<Record<StepName, StepRecord>>;
  /** `owner/name` of the app's GitHub repository. */
  repo?: string;
  coolify?: CoolifyState;
  database?: DatabaseState;
  sentryDsn?: string;
  langfuse?: LangfuseState;
  statusTokens?: StatusTokenState;
  /**
   * `BETTER_AUTH_SECRET` — generated once, for this app, and kept only here: it is the one
   * `REQUIRED_ENV` secret no provider hands back, so nothing else can be asked for it again.
   * Never printed; it reaches the app through the Coolify env PATCH alone.
   */
  betterAuthSecret?: string;
  lastRestoreCheckAt?: string;
  lastDeployedSha?: string;
}

/** 32 random bytes, the length `better-auth` documents, in the form an env var can carry. */
export function generateBetterAuthSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A fingerprint of every secret the Coolify envs carry, so a rotation is detectable without
 * keeping a second copy of the secrets themselves.
 *
 * Only the values matter, not the state around them: `coolify.envsSecretsHash` is compared
 * against this, and a step that rotated a password must come out different.
 */
export function secretsHash(state: AppState): string {
  const database = state.database ?? {};
  const material = [
    database.migratorPassword,
    database.applicationPassword,
    database.readonlyPassword,
    state.betterAuthSecret,
    state.statusTokens?.read,
    state.statusTokens?.write,
  ];
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

/**
 * The state file exists but does not parse, or does not have the shape above.
 *
 * Never repaired and never overwritten: the file is the only copy of three database passwords,
 * two status tokens and a Langfuse secret key, so silently starting a fresh one would strand a
 * deployed app whose roles nothing can log in as any more. The operator is told where the file
 * is and decides.
 */
export class AppStateInvalid extends Error {
  readonly file: string;

  constructor(file: string, problem: string) {
    super(
      `${file} is not a usable hf state file: ${problem}. It is the only copy of this app's ` +
        `passwords and tokens, so nothing was overwritten — inspect it, or move it aside to ` +
        `start over.`,
    );
    this.name = "AppStateInvalid";
    this.file = file;
  }
}

export interface AppStateStore {
  readonly file: string;
  /** The state as last written. Replaced, never mutated in place, by `patch` and `markDone`. */
  readonly state: AppState;
  isDone(step: StepName): boolean;
  markDone(step: StepName): Promise<void>;
  /**
   * Forgets a step, so the next run repeats it.
   *
   * What a rotation needs: the secrets the `coolify` step PATCHed and the `deploy` that published
   * them are no longer true of the app, and `patch` merges rather than removes.
   */
  clearDone(step: StepName): Promise<void>;
  /**
   * Merges `changes` in and writes the file. Object-valued keys (`coolify`, `database`,
   * `langfuse`, `statusTokens`) merge field by field, so a step can record the one uuid it
   * learned without carrying the rest.
   */
  patch(changes: Partial<AppState>): Promise<void>;
}

/** `~/.config/hf/state`, one `<name>.json` per app. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configHome(env), "state");
}

export function stateFile(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), `${name}.json`);
}

export interface OpenAppStateOptions {
  /** The directory holding `<name>.json`. Defaults to `stateDir()`. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Opens one app's state cache, or starts an empty one when the file does not exist yet.
 *
 * The file must be mode 0600; a looser one is tightened and then refused (`InsecureFileMode`).
 */
export async function openAppState(
  name: string,
  options: OpenAppStateOptions = {},
): Promise<AppStateStore> {
  const env = options.env ?? process.env;
  const file =
    options.dir === undefined ? stateFile(name, env) : path.join(options.dir, `${name}.json`);

  const contents = await readSecretFile(file);
  let state: AppState = contents === undefined ? { steps: {} } : parseAppState(contents, file);

  const write = async (next: AppState): Promise<void> => {
    await writeSecretFile(file, `${JSON.stringify(next, null, 2)}\n`);
    state = next;
  };

  return {
    file,
    get state() {
      return state;
    },
    isDone: (step) => state.steps[step] !== undefined,
    markDone: async (step) => {
      await write({
        ...state,
        steps: { ...state.steps, [step]: { doneAt: new Date().toISOString() } },
      });
    },
    clearDone: async (step) => {
      if (state.steps[step] === undefined) return;
      const steps = { ...state.steps };
      delete steps[step];
      await write({ ...state, steps });
    },
    patch: async (changes) => {
      await write(merge(state, changes));
    },
  };
}

function merge(state: AppState, changes: Partial<AppState>): AppState {
  return {
    ...state,
    ...changes,
    steps: { ...state.steps, ...changes.steps },
    ...mergeObject(state, changes, "coolify"),
    ...mergeObject(state, changes, "database"),
    ...mergeObject(state, changes, "langfuse"),
    ...mergeObject(state, changes, "statusTokens"),
  };
}

function mergeObject<Key extends "coolify" | "database" | "langfuse" | "statusTokens">(
  state: AppState,
  changes: Partial<AppState>,
  key: Key,
): Partial<AppState> {
  const change = changes[key];
  if (change === undefined) return {};
  return { [key]: { ...state[key], ...change } } as Partial<AppState>;
}

/**
 * The schema, hand-written because the whole contract is nine keys and a step map, and because
 * an unknown key has to be an error rather than something a permissive parser drops on the next
 * write.
 */
function parseAppState(contents: string, file: string): AppState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new AppStateInvalid(file, "it is not valid JSON");
  }
  const root = asObject(parsed, file, "the top level");

  const state: AppState = { steps: {} };
  for (const [key, value] of Object.entries(root)) {
    switch (key) {
      case "steps":
        state.steps = parseSteps(value, file);
        break;
      case "repo":
      case "sentryDsn":
      case "betterAuthSecret":
      case "lastRestoreCheckAt":
      case "lastDeployedSha":
        state[key] = asString(value, file, key);
        break;
      case "coolify":
        state.coolify = parseFields(value, file, key, [
          "projectUuid",
          "appUuid",
          "envsSecretsHash",
        ]);
        break;
      case "database":
        state.database = parseFields(value, file, key, [
          "migratorPassword",
          "applicationPassword",
          "readonlyPassword",
        ]);
        break;
      case "langfuse":
        state.langfuse = parseFields(value, file, key, ["publicKey", "secretKey"]);
        break;
      case "statusTokens":
        state.statusTokens = parseFields(value, file, key, ["read", "write"]);
        break;
      default:
        throw new AppStateInvalid(file, `${JSON.stringify(key)} is not an hf state key`);
    }
  }
  if (root.steps === undefined) throw new AppStateInvalid(file, "it has no steps");
  return state;
}

function parseSteps(value: unknown, file: string): Partial<Record<StepName, StepRecord>> {
  const steps: Partial<Record<StepName, StepRecord>> = {};
  for (const [name, record] of Object.entries(asObject(value, file, "steps"))) {
    if (!(STEPS as readonly string[]).includes(name)) {
      throw new AppStateInvalid(file, `steps.${name} is not a step of hf new`);
    }
    const fields = asObject(record, file, `steps.${name}`);
    steps[name as StepName] = { doneAt: asString(fields.doneAt, file, `steps.${name}.doneAt`) };
  }
  return steps;
}

function parseFields<Field extends string>(
  value: unknown,
  file: string,
  key: string,
  fields: readonly Field[],
): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  for (const [field, entry] of Object.entries(asObject(value, file, key))) {
    if (!(fields as readonly string[]).includes(field)) {
      throw new AppStateInvalid(file, `${key}.${field} is not an hf state key`);
    }
    out[field as Field] = asString(entry, file, `${key}.${field}`);
  }
  return out;
}

function asObject(value: unknown, file: string, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppStateInvalid(file, `${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, file: string, what: string): string {
  if (typeof value !== "string") throw new AppStateInvalid(file, `${what} is not a string`);
  return value;
}
