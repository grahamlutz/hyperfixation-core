import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireOperatorConfig, type ConfigKey, type OperatorConfig } from "../config.js";
import { declaredNames } from "../env-file.js";
import type { Step } from "../new-cloud.js";
import { CoolifyClient, type CoolifyEnvironmentVariable } from "../providers/coolify.js";
import { generateBetterAuthSecret, secretsHash } from "../state.js";
import { appFqdn, StepFailed, type CloudStepContext } from "./context.js";

/** The Coolify environment every `hf new` application lives in; created with the project. */
export const COOLIFY_ENVIRONMENT = "production";

/** Where the build pack looks for the compose file, relative to the repository root. */
export const COMPOSE_LOCATION = "/docker-compose.prod.yml";

/**
 * The compose service the app's domain is attached to — the one the template publishes 3000 from.
 *
 * A `dockercompose` application cannot take `domains` at all (Coolify 4.3.21: 422 `The domains
 * field cannot be used for dockercompose applications`), and `docker_compose_domains` names a
 * service, so one of them has to be named here. A template that renamed `web` would deploy an app
 * Coolify's proxy routes nothing to, which is why this is a constant with a test behind it rather
 * than a literal in the payload.
 */
export const COMPOSE_DOMAIN_SERVICE = "web";

/** The compose file the drift assertion reads, under the app's directory. */
export const PROD_COMPOSE_FILE = "docker-compose.prod.yml";

/**
 * Set by compose itself rather than by us: `DOCKER_IMAGE` has a default in the `x-app` anchor and
 * `SOURCE_COMMIT` is what Coolify's builder exports for the image tag and the build arg. Sending
 * either as an application environment variable would override the deploy's own.
 */
export const COMPOSE_PROVIDED_ENV = ["DOCKER_IMAGE", "SOURCE_COMMIT"] as const;

/** Written literally into every `environment:` block, so the deploy never carries them. */
export const CONTAINER_PROVIDED_ENV = ["HF_PROCESS", "HF_BUILD_SHA"] as const;

/**
 * The two variables `hf new` omits when the operator has no key for them.
 *
 * An app with neither serves fixture drafts and says so on `/api/status` (`llm.mode`); an empty
 * variable in Coolify's UI reads as configured, so the absence is the honest state and the
 * checklist is what says it out loud.
 */
export const OPTIONAL_PROVIDER_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/**
 * The three `hf new` omits when the `langfuse` step provisioned no keys.
 *
 * All three or none: the template's gate — `instrumentation.ts` in the web, `startWorker()` in the
 * worker — registers the span processor only when none of them is empty, so a base URL on its own
 * configures nothing and only reads as though it did.
 */
export const OPTIONAL_LANGFUSE_ENV = [
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
] as const;

/** Which operator key carries each of them, in `REQUIRED_ENV` order. */
const PROVIDER_ENV_SOURCE: readonly (readonly [string, ConfigKey])[] = [
  ["ANTHROPIC_API_KEY", "HF_ANTHROPIC_API_KEY"],
  ["OPENAI_API_KEY", "HF_OPENAI_API_KEY"],
];

/** The operator config the environment itself is built out of. */
const REQUIRED_FOR_ENVS = [
  "HF_COOLIFY_POSTGRES_UUID",
  "HF_SMTP_URL",
  "HF_EMAIL_FROM",
  "HF_LANGFUSE_URL",
] as const;

/**
 * The app's environment and what `docker-compose.prod.yml` interpolates have diverged.
 *
 * Raised before the first Coolify request of the run, because the failure it prevents is silent: a
 * variable the template added and nothing sent is an empty string in three containers, and only
 * the one that reads it finds out.
 */
export class EnvDrift extends StepFailed {
  readonly missing: readonly string[];
  readonly extra: readonly string[];

  constructor(missing: readonly string[], extra: readonly string[]) {
    super(
      `the app's environment has drifted from ${PROD_COMPOSE_FILE}: ` +
        [
          missing.length === 0 ? "" : `${missing.join(", ")} needed but not sent`,
          extra.length === 0 ? "" : `${extra.join(", ")} sent but not needed`,
        ]
          .filter((part) => part !== "")
          .join("; ") +
        ". Nothing was sent to Coolify — reconcile .env.example, REQUIRED_ENV and every " +
        "environment: block first.",
    );
    this.name = "EnvDrift";
    this.missing = missing;
    this.extra = extra;
  }
}

/** Every `${VAR}` a compose file interpolates, `${VAR:-default}` and `${VAR?err}` included. */
export function composeInterpolatedNames(contents: string): string[] {
  const names = new Set<string>();
  for (const match of contents.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g)) {
    names.add(match[1]!);
  }
  return [...names];
}

/**
 * What the deployed app needs from its environment, read from the generated app itself.
 *
 * Both halves, because they fail differently: `.env.example` is the declared contract (and equals
 * `REQUIRED_ENV`, which the template's own test enforces), while the compose interpolations are
 * what actually reaches a container. A variable in one and not the other is drift too.
 */
export async function neededEnvNames(dir: string): Promise<string[]> {
  const declared = declaredNames(await readFile(path.join(dir, ".env.example"), "utf8"));
  const interpolated = composeInterpolatedNames(
    await readFile(path.join(dir, PROD_COMPOSE_FILE), "utf8"),
  );

  const provided = new Set<string>([...COMPOSE_PROVIDED_ENV, ...CONTAINER_PROVIDED_ENV]);
  return [...new Set([...declared, ...interpolated])].filter((name) => !provided.has(name));
}

/**
 * Refuses to PATCH an environment that is not the one the compose file needs.
 *
 * A provider key the operator has not configured, and the three Langfuse variables when the step
 * provisioned no keys, are deliberately absent rather than missing: each is excused here and
 * reported in the checklist instead.
 */
export async function assertEnvsMatchCompose(dir: string, sent: readonly string[]): Promise<void> {
  const needed = await neededEnvNames(dir);
  const sentNames = new Set(sent);
  const optional = new Set<string>([...OPTIONAL_PROVIDER_ENV, ...OPTIONAL_LANGFUSE_ENV]);

  const missing = needed.filter((name) => !sentNames.has(name) && !optional.has(name));
  const extra = sent.filter((name) => !needed.includes(name));
  if (missing.length > 0 || extra.length > 0) throw new EnvDrift(missing, extra);
}

/**
 * The twelve variables the deployed app runs on, less any of the five optional ones — the two
 * provider keys and the three Langfuse variables — that nothing provisioned.
 *
 * Generates `BETTER_AUTH_SECRET` on first sight and records it: it is the one value in the list
 * that no provider hands back, so a run that did not persist it would lock every existing session
 * out on the next deploy.
 */
export async function buildAppEnvs(context: CloudStepContext): Promise<CoolifyEnvironmentVariable[]> {
  const config = requireOperatorConfig(context.config, REQUIRED_FOR_ENVS, { env: context.env });
  const { names } = context;
  const database = context.state.state.database ?? {};

  if (database.applicationPassword === undefined || database.migratorPassword === undefined) {
    throw new StepFailed(
      "no database passwords in the state cache: the database step has not run for this app",
    );
  }

  if (context.state.state.betterAuthSecret === undefined) {
    await context.state.patch({ betterAuthSecret: generateBetterAuthSecret() });
  }

  // The hostname the app's containers reach Postgres by, which is not the one the tunnel uses.
  // Coolify's own compose generator names the container after the database's uuid;
  // `HF_DB_HOST_INTERNAL` is how a box that disagrees says so.
  const host = context.config.HF_DB_HOST_INTERNAL ?? config.HF_COOLIFY_POSTGRES_UUID;
  const langfuse = context.state.state.langfuse ?? {};

  const envs: CoolifyEnvironmentVariable[] = [
    {
      key: "DATABASE_URL",
      value: internalUrl(names.applicationRole, database.applicationPassword, host, names.databaseName),
    },
    {
      key: "MIGRATOR_DATABASE_URL",
      value: internalUrl(names.migratorRole, database.migratorPassword, host, names.databaseName),
    },
    { key: "APP_URL", value: `https://${appFqdn(context)}` },
    { key: "BETTER_AUTH_SECRET", value: context.state.state.betterAuthSecret ?? "" },
    { key: "SMTP_URL", value: config.HF_SMTP_URL },
    { key: "EMAIL_FROM", value: config.HF_EMAIL_FROM },
    { key: "SENTRY_DSN", value: context.state.state.sentryDsn ?? "" },
  ];

  // Omitted outright when the langfuse step reused nothing and created nothing: an empty trio
  // would deploy the same telemetry — none — while reading as configured in Coolify's UI.
  if (langfuse.publicKey !== undefined && langfuse.secretKey !== undefined) {
    envs.push(
      { key: "LANGFUSE_BASE_URL", value: config.HF_LANGFUSE_URL },
      { key: "LANGFUSE_PUBLIC_KEY", value: langfuse.publicKey },
      { key: "LANGFUSE_SECRET_KEY", value: langfuse.secretKey },
    );
  }

  for (const [key, value] of providerKeys(context.config)) envs.push({ key, value });
  return envs;
}

/** The provider keys the operator configured, in `REQUIRED_ENV` order; absent ones are omitted. */
export function providerKeys(config: OperatorConfig): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [name, source] of PROVIDER_ENV_SOURCE) {
    const value = config[source];
    if (value !== undefined && value !== "") pairs.push([name, value]);
  }
  return pairs;
}

/**
 * The Coolify project, environment and application, the app's whole environment, and the three
 * commands that have to run against the database before the first deploy.
 *
 * Every sub-action is found by name before it is created, and every uuid is recorded the moment
 * the API hands it back, so a crash anywhere in here leaves a rerun with something to find rather
 * than a second project beside the first.
 */
export const coolifyStep: Step<CloudStepContext> = {
  name: "coolify",
  run: async (context) => {
    const { state, names } = context;
    const required = requireOperatorConfig(
      context.config,
      ["HF_COOLIFY_URL", "HF_COOLIFY_TOKEN"],
      { env: context.env },
    );
    const coolify = new CoolifyClient({
      url: required.HF_COOLIFY_URL,
      token: required.HF_COOLIFY_TOKEN,
      fetch: context.fetch,
    });

    // Before the first request, so drift costs nothing but the message.
    const envs = await buildAppEnvs(context);
    await assertEnvsMatchCompose(
      context.dir,
      envs.map((env) => env.key),
    );

    const projectUuid = await findOrCreateProject(context, coolify);
    const environmentUuid = await productionEnvironment(context, coolify, projectUuid);
    const appUuid = await findOrCreateApplication(context, coolify, projectUuid, environmentUuid);

    // Unconditionally, every time this step runs. The step is recorded only while
    // `coolify.envsSecretsHash` still matches the state's secrets, so a rotation has already made
    // the runner forget it — which means "not done" and "the secrets moved" both land here.
    await coolify.updateEnvsBulk(appUuid, envs);
    context.io.out(`${names.given}: ${String(envs.length)} environment variable(s) set in Coolify`);

    await runThroughTunnel(context, envs);

    // Last, not straight after the PATCH: `status-token` mints secrets that `secretsHash` covers,
    // so a hash recorded before it would be stale the moment this step returned.
    await state.patch({ coolify: { envsSecretsHash: secretsHash(state.state) } });
  },
};

async function findOrCreateProject(
  context: CloudStepContext,
  coolify: CoolifyClient,
): Promise<string> {
  const name = context.names.given;
  const existing = (await coolify.listProjects()).find((project) => project.name === name);
  if (existing !== undefined) {
    await context.state.patch({ coolify: { projectUuid: existing.uuid } });
    return existing.uuid;
  }

  const created = await coolify.createProject({
    name,
    description: `hyperfixation app ${name}`,
  });
  await context.state.patch({ coolify: { projectUuid: created.uuid } });
  context.io.out(`${name}: created the Coolify project ${name}`);
  return created.uuid;
}

async function productionEnvironment(
  context: CloudStepContext,
  coolify: CoolifyClient,
  projectUuid: string,
): Promise<string> {
  const environments = await coolify.listEnvironments(projectUuid);
  const production = environments.find((environment) => environment.name === COOLIFY_ENVIRONMENT);
  if (production !== undefined) return production.uuid;

  const created = await coolify.createEnvironment(projectUuid, { name: COOLIFY_ENVIRONMENT });
  context.io.out(
    `${context.names.given}: created the ${COOLIFY_ENVIRONMENT} environment in the Coolify project`,
  );
  return created.uuid;
}

async function findOrCreateApplication(
  context: CloudStepContext,
  coolify: CoolifyClient,
  projectUuid: string,
  environmentUuid: string,
): Promise<string> {
  const name = context.names.given;
  const existing = (await coolify.listApplications()).find(
    (application) => application.name === name,
  );
  if (existing !== undefined) {
    await context.state.patch({ coolify: { appUuid: existing.uuid } });
    return existing.uuid;
  }

  const repo = context.state.state.repo;
  if (repo === undefined) {
    throw new StepFailed(
      "no owner/name repository in the state cache: the repo step has not run for this app",
    );
  }
  const required = requireOperatorConfig(
    context.config,
    ["HF_COOLIFY_SERVER_UUID", "HF_COOLIFY_GITHUB_APP_UUID"],
    { env: context.env },
  );
  const fqdn = appFqdn(context);

  const created = await coolify.createPrivateGithubAppApplication({
    project_uuid: projectUuid,
    server_uuid: required.HF_COOLIFY_SERVER_UUID,
    environment_name: COOLIFY_ENVIRONMENT,
    environment_uuid: environmentUuid,
    github_app_uuid: required.HF_COOLIFY_GITHUB_APP_UUID,
    git_repository: repo,
    git_branch: "main",
    build_pack: "dockercompose",
    docker_compose_location: COMPOSE_LOCATION,
    connect_to_docker_network: true,
    name,
    docker_compose_domains: [{ name: COMPOSE_DOMAIN_SERVICE, domain: `https://${fqdn}` }],
    // The `deploy` step is what deploys, once the environment is set and the database migrated.
    instant_deploy: false,
  });
  await context.state.patch({ coolify: { appUuid: created.uuid } });
  context.io.out(`${name}: created the Coolify application at https://${fqdn}`);
  return created.uuid;
}

/**
 * `migrate`, `bootstrap` and `status-token` against the new database, through the E2 tunnel.
 *
 * The children get the app's own environment with the two connection URLs pointed at the tunnel —
 * never a `.env`, and never this laptop's: an operator with their own `DATABASE_URL` exported would
 * otherwise have the tokens provisioned into a dev database.
 */
async function runThroughTunnel(
  context: CloudStepContext,
  envs: readonly CoolifyEnvironmentVariable[],
): Promise<void> {
  const { names } = context;
  const database = await context.database();
  const local = database.adminUrl(names.databaseName);
  if (local === undefined) {
    throw new StepFailed(
      `migrate, bootstrap and status-token cannot run over the ${database.kind} transport: each ` +
        "is a pg client and needs an address. Publish the Coolify Postgres port on the box's " +
        "loopback so the tunnel works.",
    );
  }

  const stored = context.state.state.database ?? {};
  const overlay: Record<string, string> = {};
  for (const env of envs) overlay[env.key] = env.value;
  overlay.DATABASE_URL = asRole(local, names.applicationRole, stored.applicationPassword ?? "");
  overlay.MIGRATOR_DATABASE_URL = asRole(local, names.migratorRole, stored.migratorPassword ?? "");

  // The roles already exist — the database step created them — and the migrator role in the cloud
  // cannot create one anyway.
  await context.commands.migrate({ dir: context.dir, env: overlay });
  context.io.out(`${names.given}: migrated ${names.databaseName}`);

  await context.commands.bootstrap({
    dir: context.dir,
    env: overlay,
    email: context.email,
    budgetUsd: context.budgetUsd,
  });
  context.io.out(`${names.given}: bootstrapped ${context.email} with a $${context.budgetUsd} budget`);

  // The state file is the only copy of the plaintext, so "already minted" means "in the state",
  // not "hashed in the database" — and a rerun that finds a hash it has no plaintext for has to
  // replace it, which is what `rotate` is for. Nothing else holds either token.
  if (context.state.state.statusTokens?.read === undefined) {
    const tokens = await context.commands.statusToken({ dir: context.dir, env: overlay });
    await context.state.patch({ statusTokens: tokens });
    context.io.out(`${names.given}: minted the /api/status read and write tokens`);
  }
}

function internalUrl(role: string, password: string, host: string, databaseName: string): string {
  return `postgres://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${host}:5432/${databaseName}`;
}

function asRole(url: string, role: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(role);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}
