import { StepFailed, type StepOut } from "./cloud-steps/index.js";
import { loadOperatorConfig, requireOperatorConfig, type OperatorConfig } from "./config.js";
import { deployApp } from "./deploy-app.js";
import { deriveNames } from "./names.js";
import { CoolifyClient } from "./providers/coolify.js";
import type { FetchLike } from "./providers/http.js";
import { openAppState } from "./state.js";

/**
 * The app environment variables `hf rotate-key` will replace: the provider keys and the channel
 * credentials, and nothing else.
 *
 * A list rather than any name the operator types, because the rest of the app's environment cannot
 * be rotated by a PATCH alone. `DATABASE_URL` and `MIGRATOR_DATABASE_URL` carry a role password
 * that also has to change in the cluster (`hf new`'s `database` step), and `BETTER_AUTH_SECRET`
 * lives in the state cache and would sign every existing session out. Both are jobs of their own,
 * and neither should be reachable by a typo here.
 *
 * `TELEGRAM_*` and `LOB_API_KEY` are named before the channels that read them exist (Phase 6 F2
 * and F3): the account and the key come first, and P0 sets them through this command.
 */
export const ROTATABLE_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "SMTP_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "LOB_API_KEY",
] as const;

export type RotatableEnv = (typeof ROTATABLE_ENV)[number];

/** A variable name this command will not rotate; the message lists the ones it will. */
export class NotRotatable extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(
      `${variable} is not one of the variables hf rotate-key replaces ` +
        `(${ROTATABLE_ENV.join(", ")})`,
    );
    this.name = "NotRotatable";
    this.variable = variable;
  }
}

/**
 * Nothing usable arrived on stdin.
 *
 * The message never quotes what did: the whole point of reading the value here is that it is in no
 * argument list, no shell history and no log line, and an error that echoed it would undo that.
 */
export class NoKeyOnStdin extends Error {
  constructor(problem: string) {
    super(
      `hf rotate-key reads the new value from stdin, and ${problem}. Pipe it in — ` +
        "`~/.config/hf/setkey.sh | hf rotate-key <name> <VAR>` — never as an argument.",
    );
    this.name = "NoKeyOnStdin";
  }
}

/** Stdin as this command reads it: a stream of chunks that may know it is a terminal. */
export interface KeyInput extends AsyncIterable<Uint8Array | string> {
  isTTY?: boolean;
}

/**
 * The one line on stdin, as the new value.
 *
 * A terminal is refused rather than prompted at: a value typed at a prompt is echoed, and a value
 * echoed is a value in a scrollback. Surrounding whitespace goes — a paste and a `printf` differ by
 * a newline and nothing else — and a value that is still more than one line is refused, since
 * Coolify would store it and the container read a truncation.
 */
export async function readKeyFromStdin(input: KeyInput): Promise<string> {
  if (input.isTTY === true) throw new NoKeyOnStdin("stdin is a terminal");

  const chunks: string[] = [];
  for await (const chunk of input) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }

  const value = chunks.join("").trim();
  if (value === "") throw new NoKeyOnStdin("nothing arrived on it");
  if (/[\r\n]/.test(value)) throw new NoKeyOnStdin("what arrived spans more than one line");
  return value;
}

export interface RotateKeyOptions {
  /** The app as `hf new` named it, which is also its state file's name. */
  app: string;
  variable: string;
  /** The new value, already read from stdin. Never printed, and never kept by this command. */
  value: string;
  io: StepOut;
  config?: OperatorConfig;
  /** Where the per-app state files are. Defaults to `stateDir()`. */
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  now?: () => Date;
  /** How the app is redeployed afterwards. Defaults to `hf deploy <name>` against main. */
  deploy?: () => Promise<void>;
}

export interface RotateKeyResult {
  app: string;
  variable: RotatableEnv;
  /** ISO 8601, as recorded in the state file. */
  rotatedAt: string;
  /** True when Coolify had no entry under the name and one was created instead of replaced. */
  created: boolean;
}

/**
 * `hf rotate-key <name> <VAR>` — a new value into Coolify's environment, a date into the state
 * file, and a deploy so the containers pick it up.
 *
 * The value passes through this process and stops there. It goes out in the one Coolify request
 * that has to carry it — declared as that request's secret, so a 422 quoting it comes back redacted
 * — and what is written to the laptop is `keys.<VAR>.rotatedAt` and nothing else. No line this
 * prints contains it, not even a prefix of it: `hf doctor`'s `keys` line is built from the name and
 * that date, which is all key hygiene needs.
 *
 * The deploy is not optional. Coolify holds the new value the moment the PATCH returns, and the
 * running containers hold the old one until they are replaced, so a rotation that stopped at the
 * PATCH would read as done while the revoked key is still the live one.
 */
export async function rotateKey(options: RotateKeyOptions): Promise<RotateKeyResult> {
  const env = options.env ?? process.env;
  const names = deriveNames(options.app);
  if (!(ROTATABLE_ENV as readonly string[]).includes(options.variable)) {
    throw new NotRotatable(options.variable);
  }
  const variable = options.variable as RotatableEnv;
  if (options.value === "") throw new NoKeyOnStdin("nothing arrived on it");

  const config = options.config ?? (await loadOperatorConfig({ env }));
  const required = requireOperatorConfig(config, ["HF_COOLIFY_URL", "HF_COOLIFY_TOKEN"], { env });

  const store = await openAppState(names.given, { dir: options.stateDir, env });
  const appUuid = store.state.coolify?.appUuid;
  if (appUuid === undefined) {
    throw new StepFailed(
      `${store.file} has no Coolify application uuid: hf new has not finished provisioning ` +
        `${names.given}, and there is no environment to rotate`,
    );
  }

  const coolify = new CoolifyClient({
    url: required.HF_COOLIFY_URL,
    token: required.HF_COOLIFY_TOKEN,
    fetch: options.fetch,
  });

  // The non-preview entry alone. Coolify materialises a preview twin for every variable a compose
  // file interpolates, and a preview deployment is something `hf` never makes — one request that
  // carries a secret is one more place for it to be logged.
  const existing = (await coolify.listEnvs(appUuid)).filter(
    (entry) => entry.key === variable && entry.is_preview !== true,
  );

  const created = existing.length === 0;
  if (created) {
    await coolify.createEnv(appUuid, { key: variable, value: options.value });
  } else {
    await coolify.updateEnv(appUuid, { key: variable, value: options.value, is_preview: false });
  }
  options.io.out(
    `${names.given}: ${variable} ${created ? "created" : "replaced"} in Coolify ` +
      "(the value is not printed anywhere)",
  );

  // Recorded before the deploy, not after: Coolify already holds the new value, and a deploy that
  // fails is one to rerun rather than a rotation to forget.
  const rotatedAt = (options.now ?? (() => new Date()))().toISOString();
  await store.patch({ keys: { [variable]: { rotatedAt } } });
  options.io.out(`${names.given}: keys.${variable}.rotatedAt ${rotatedAt} recorded in ${store.file}`);

  const deploy =
    options.deploy ??
    (async () => {
      await deployApp({
        app: names.given,
        io: options.io,
        config,
        stateDir: options.stateDir,
        env,
        fetch: options.fetch,
      });
    });
  await deploy();

  return { app: names.given, variable, rotatedAt, created };
}
