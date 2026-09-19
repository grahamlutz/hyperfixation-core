import { homedir } from "node:os";
import path from "node:path";
import { readSecretFile } from "./secret-file.js";

/**
 * Every key the operator's config may carry, spelled exactly as the environment variable that
 * overrides it. One flat list of names, no nesting: these are pasted in from account pages, and
 * a shape is one more thing to get wrong.
 */
export const CONFIG_KEYS = [
  "HF_COOLIFY_URL",
  "HF_COOLIFY_TOKEN",
  "HF_COOLIFY_SERVER_UUID",
  "HF_COOLIFY_GITHUB_APP_UUID",
  "HF_COOLIFY_POSTGRES_UUID",
  "HF_SSH_HOST",
  "HF_CLOUDFLARE_TOKEN",
  "HF_CLOUDFLARE_ZONE_ID",
  "HF_BASE_DOMAIN",
  "HF_GITHUB_TOKEN",
  "HF_GITHUB_OWNER",
  "HF_SENTRY_TOKEN",
  "HF_SENTRY_ORG",
  "HF_LANGFUSE_URL",
  "HF_LANGFUSE_ORG_KEY",
  "HF_BOX_IP",
  "HF_SMTP_URL",
  "HF_EMAIL_FROM",
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** What the operator has configured. Every key is optional until a command asks for it. */
export type OperatorConfig = Partial<Record<ConfigKey, string>>;

const KEYS = new Set<string>(CONFIG_KEYS);

/** `~/.config/hf`, or `$XDG_CONFIG_HOME/hf`. Holds `config.json` and `state/`. */
export function configHome(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME;
  return path.join(base !== undefined && base !== "" ? base : path.join(homedir(), ".config"), "hf");
}

export function configFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configHome(env), "config.json");
}

/** The config file exists but is not a flat JSON object of known keys to strings. */
export class ConfigFileInvalid extends Error {
  readonly file: string;

  constructor(file: string, problem: string) {
    // The file holds tokens: the problem is described by key name, never by value, and the
    // JSON parser's own message is dropped because it quotes the text it choked on.
    super(`${file} is not usable hf config: ${problem}`);
    this.name = "ConfigFileInvalid";
    this.file = file;
  }
}

/** One command needed keys the operator has not set. Names every one of them, values never. */
export class MissingConfig extends Error {
  readonly names: readonly ConfigKey[];

  constructor(names: readonly ConfigKey[], file: string) {
    super(
      `${names.join(", ")} unset: set ${names.length === 1 ? "it" : "them"} in ${file} ` +
        `or in the environment`,
    );
    this.name = "MissingConfig";
    this.names = names;
  }
}

export interface LoadOperatorConfigOptions {
  /** The config file to read. Defaults to `configFile()`. */
  file?: string;
  /** The environment that overrides it. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Reads `~/.config/hf/config.json` and lays the environment over it.
 *
 * The environment wins, the same precedence an app's `.env` has under `process.env`, so a
 * one-off `HF_COOLIFY_URL=… hf new` does not mean editing a file. A missing file is not an
 * error here — `requireOperatorConfig` is what reports what a command actually needs, all at
 * once, rather than one failed request at a time.
 *
 * The file must be mode 0600; see `readSecretFile`.
 */
export async function loadOperatorConfig(
  options: LoadOperatorConfigOptions = {},
): Promise<OperatorConfig> {
  const env = options.env ?? process.env;
  const file = options.file ?? configFile(env);

  const config: OperatorConfig = {};
  const contents = await readSecretFile(file);
  if (contents !== undefined) {
    for (const [key, value] of Object.entries(parseConfig(contents, file))) {
      config[key as ConfigKey] = value;
    }
  }

  for (const key of CONFIG_KEYS) {
    const override = env[key];
    if (override !== undefined && override !== "") config[key] = override;
  }
  return config;
}

/**
 * Narrows a loaded config to the keys a command needs, or names **every** missing one.
 *
 * All at once on purpose: provisioning fails at the first request that needs a key it has not
 * got, and an operator who fixes one key per run pays for a partly-provisioned app each time.
 */
export function requireOperatorConfig<Key extends ConfigKey>(
  config: OperatorConfig,
  keys: readonly Key[],
  options: LoadOperatorConfigOptions = {},
): Record<Key, string> {
  const missing: ConfigKey[] = [];
  const required = {} as Record<Key, string>;
  for (const key of keys) {
    const value = config[key];
    if (value === undefined || value === "") missing.push(key);
    else required[key] = value;
  }
  if (missing.length > 0) {
    throw new MissingConfig(missing, options.file ?? configFile(options.env));
  }
  return required;
}

function parseConfig(contents: string, file: string): OperatorConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new ConfigFileInvalid(file, "it is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigFileInvalid(file, "the top level is not an object");
  }

  const config: OperatorConfig = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!KEYS.has(key)) {
      throw new ConfigFileInvalid(file, `${JSON.stringify(key)} is not an hf config key`);
    }
    if (typeof value !== "string") {
      throw new ConfigFileInvalid(file, `${key} is not a string`);
    }
    config[key as ConfigKey] = value;
  }
  return config;
}
