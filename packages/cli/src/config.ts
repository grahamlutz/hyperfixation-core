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
  // The Postgres container's hostname on the docker network, as the app's containers see it.
  // Configurable because Coolify's API document reports no such field: its own compose generator
  // names the container after the database's uuid, so `HF_COOLIFY_POSTGRES_UUID` is the default a
  // caller falls back to, and this is how a box that disagrees is told to us rather than guessed.
  "HF_DB_HOST_INTERNAL",
  "HF_SSH_HOST",
  "HF_CLOUDFLARE_TOKEN",
  "HF_CLOUDFLARE_ZONE_ID",
  "HF_BASE_DOMAIN",
  "HF_GITHUB_TOKEN",
  "HF_GITHUB_OWNER",
  // Comma-separated `app_slug`s — Coolify's GitHub App and the bump bot's — every one of which
  // has to be installed on a new app's repository; `githubAppSlugs` is what splits it.
  "HF_GITHUB_APP_SLUGS",
  "HF_SENTRY_TOKEN",
  "HF_SENTRY_ORG",
  "HF_LANGFUSE_URL",
  // Optional, and all three are: an organization-scoped key pair creates the app its own project,
  // but it is a paid-plan feature, so a Hobby account instead names an existing project's key pair
  // here and every app it provisions traces into that one project. With none of them set the
  // langfuse step records nothing and the three LANGFUSE_* variables are omitted rather than sent
  // empty — an empty value in Coolify's UI reads as configured.
  "HF_LANGFUSE_ORG_KEY",
  "HF_LANGFUSE_PUBLIC_KEY",
  "HF_LANGFUSE_SECRET_KEY",
  "HF_BOX_IP",
  "HF_SMTP_URL",
  "HF_EMAIL_FROM",
  // The two model-provider keys, and the only optional ones here. An app deployed without
  // either serves fixture drafts (`/api/status` reports `llm.mode`), so `hf new` omits the
  // variable altogether rather than sending an empty one and printing a checklist line — an
  // empty value in Coolify's UI reads as configured.
  "HF_ANTHROPIC_API_KEY",
  "HF_OPENAI_API_KEY",
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

/**
 * `HF_GITHUB_APP_SLUGS` as a list: split on commas, trimmed, empties dropped.
 *
 * A config value is a string — one flat list of names is the whole contract — so the split lives
 * here rather than in the file format, and an unset key is an empty list: nothing to assert.
 */
export function githubAppSlugs(config: OperatorConfig): readonly string[] {
  return (config.HF_GITHUB_APP_SLUGS ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter((slug) => slug !== "");
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
