import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { bootstrapApp } from "../bootstrap.js";
import { requireOperatorConfig, type OperatorConfig } from "../config.js";
import type { Database } from "../database.js";
import { migrateApp } from "../migrate.js";
import type { AppNames } from "../names.js";
import type { CloudContext } from "../new-cloud.js";
import type { FetchLike } from "../providers/http.js";
import { statusTokenApp } from "../status-token.js";
import { fetchTemplate } from "../template-source.js";

/**
 * A step refused to act, or a command it ran failed.
 *
 * Carries no provider body and no environment: the only thing a step is allowed to say about a
 * secret is that it has one. `ProviderError` keeps the same rule for the HTTP half.
 */
export class StepFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepFailed";
  }
}

/** Where a step's progress lines go; the CLI's `Io` satisfies it. */
export interface StepOut {
  out(line: string): void;
}

export interface StepExecOptions {
  cwd: string;
  /** Laid over this process's environment for the child alone — where a token is passed. */
  env?: Record<string, string>;
  /** Collect the output instead of letting the child write to the terminal. */
  capture?: boolean;
}

export interface StepExecOutcome {
  /** `null` when the child was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * How a step runs `git` and `pnpm`.
 *
 * An argument array and a separate environment, never a command string: the token the repo step
 * hands `git push` must reach it through the environment, where `ps` cannot read it, and an
 * interpolated command line is the one shape that cannot promise that.
 */
export type StepExec = (
  command: string,
  args: readonly string[],
  options: StepExecOptions,
) => Promise<StepExecOutcome>;

/** `fetchTemplate`, narrowed to what the template step asks of it so a test can be one. */
export type TemplateFetch = (source: string | undefined, dir: string) => Promise<string>;

/**
 * The app's own commands, as the `coolify` step runs them through the tunnel.
 *
 * An interface rather than three direct calls because these are the three things a test cannot
 * run — each needs the generated app's toolchain and a migrated database — and because the `env`
 * overlay they take is the whole point: the cloud path never reads or writes a `.env`.
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

/** What every step of a cloud `hf new` needs beyond the state the runner keeps. */
export interface CloudStepContext extends CloudContext {
  names: AppNames;
  /** Absolute path of the app directory the run creates, or adopts. */
  dir: string;
  config: OperatorConfig;
  io: StepOut;
  /**
   * Lines to print once the run is over — things only the operator can do.
   *
   * Appended to, never printed here: a line about the app's DNS is no use in the middle of the
   * provisioning it is about.
   */
  checklist: string[];
  exec: StepExec;
  /** `--from`: a giget specifier. `undefined` fetches `TEMPLATE_REPOSITORY`. */
  from?: string;
  fetchTemplate: TemplateFetch;
  fetch?: FetchLike;
  /** Named by `MissingConfig` when a step needs a key the operator has not set. */
  env?: NodeJS.ProcessEnv;
  /** The bootstrap admin's address and the app's starting budget; both required in the cloud. */
  email: string;
  budgetUsd: string;
  /**
   * The box's Postgres cluster, opened on first use and shared for the rest of the run.
   *
   * One tunnel: `database` and `coolify` both need one, and a second `ssh -L` would be a second
   * thing to leak. The run closes it in a `finally`.
   */
  database(): Promise<Database>;
  commands: CloudCommands;
  /** The clock and the wait the `deploy` step polls against; a test replaces both. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const spawnStepExec: StepExec = async (command, args, options) => {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env === undefined ? process.env : { ...process.env, ...options.env },
    // `inherit` for a command whose output the operator is meant to watch — `pnpm install` is
    // minutes long — and pipes only where a step reads the answer back.
    stdio: options.capture === true ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode));
  });
  return { code, stdout, stderr };
};

export const defaultTemplateFetch: TemplateFetch = async (source, dir) =>
  await fetchTemplate(source, dir);

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

/** `<app>.<HF_BASE_DOMAIN>` — the host Coolify serves and the passkey relying-party origin. */
export function appFqdn(context: CloudStepContext): string {
  const { HF_BASE_DOMAIN } = requireOperatorConfig(context.config, ["HF_BASE_DOMAIN"], {
    env: context.env,
  });
  return `${context.names.given}.${HF_BASE_DOMAIN}`;
}

/** Runs a command in the app directory and throws on a non-zero exit. */
export async function mustRun(
  context: CloudStepContext,
  command: string,
  args: readonly string[],
  options: { env?: Record<string, string>; capture?: boolean } = {},
): Promise<StepExecOutcome> {
  const outcome = await context.exec(command, args, { cwd: context.dir, ...options });
  if (outcome.code !== 0) {
    throw new StepFailed(
      `${command} ${args.join(" ")} exited with code ${String(outcome.code)}` +
        (outcome.stderr.trim() === "" ? "" : `: ${firstLine(outcome.stderr)}`),
    );
  }
  return outcome;
}

/** `HEAD`'s sha, or `undefined` when the directory has no commit yet — or no repository. */
export async function gitHead(context: CloudStepContext): Promise<string | undefined> {
  const outcome = await context.exec("git", ["rev-parse", "HEAD"], {
    cwd: context.dir,
    capture: true,
  });
  return outcome.code === 0 ? outcome.stdout.trim() : undefined;
}

export async function exists(target: string): Promise<boolean> {
  return await access(target).then(
    () => true,
    () => false,
  );
}

export function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

export function short(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}
