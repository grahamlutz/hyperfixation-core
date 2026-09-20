import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADMIN_URL, asRole } from "@hyperfixation/testing";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OperatorConfig } from "../config.js";
import { openDatabase, type AdminCredentials, type Database } from "../database.js";
import { deriveNames } from "../names.js";
import { runSteps, StepInvariantViolated, type Step } from "../new-cloud.js";
import { TEMPLATE_MARKER } from "../new.js";
import { createLocalRunner, type LocalRunner } from "../runner.js";
import { openAppState, secretsHash, type AppStateStore, type StepName } from "../state.js";
import {
  createRecordingExec,
  createStepContext,
  isGit,
  type TestStepContext,
} from "../test-support/cloud-step.js";
import { createOpenApiHarness, type StubRoute } from "../test-support/openapi.js";
import { findTemplateSource } from "../template-source.js";
import type { CloudCommands, CloudStepContext } from "./context.js";
import {
  COMPOSE_DOMAIN_SERVICE,
  COMPOSE_LOCATION,
  EnvDrift,
  neededEnvNames,
} from "./coolify.js";
import { CLOUD_STEPS } from "./index.js";

const COOLIFY = "https://coolify.test";
const LANGFUSE = "https://langfuse.test";
const SENTRY = "https://sentry.io";
const GITHUB = "https://api.github.com";
const CLOUDFLARE = "https://api.cloudflare.com/client/v4";
const BASE_DOMAIN = "hf.test";
const OWNER = "grahamlutz";
const BOX_IP = "203.0.113.7";
const HEAD_SHA = "1".repeat(40);
const DSN = "https://dsn-key@o1.ingest.sentry.io/1";

/** The twelve the deployed app runs on, in the order `buildAppEnvs` sends them. */
const EXPECTED_ENV_KEYS = [
  "DATABASE_URL",
  "MIGRATOR_DATABASE_URL",
  "APP_URL",
  "BETTER_AUTH_SECRET",
  "SMTP_URL",
  "EMAIL_FROM",
  "SENTRY_DSN",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
];

const CONFIG: OperatorConfig = {
  HF_COOLIFY_URL: COOLIFY,
  HF_COOLIFY_TOKEN: "coolify-token",
  HF_COOLIFY_SERVER_UUID: "server-1",
  HF_COOLIFY_GITHUB_APP_UUID: "github-app-1",
  HF_COOLIFY_POSTGRES_UUID: "postgres-uuid",
  HF_SSH_HOST: "box",
  HF_BASE_DOMAIN: BASE_DOMAIN,
  HF_SMTP_URL: "smtp://smtp.test:587",
  HF_EMAIL_FROM: "demo@hf.test",
  HF_LANGFUSE_URL: LANGFUSE,
  HF_LANGFUSE_ORG_KEY: "langfuse-org-key",
  HF_SENTRY_TOKEN: "sentry-token",
  HF_SENTRY_ORG: "hf",
  HF_GITHUB_TOKEN: "github-token",
  HF_GITHUB_OWNER: OWNER,
  HF_GITHUB_APP_SLUGS: "coolify, hyperfixation-bump",
  HF_CLOUDFLARE_TOKEN: "cloudflare-token",
  HF_CLOUDFLARE_ZONE_ID: "zone-1",
  HF_BOX_IP: BOX_IP,
  HF_ANTHROPIC_API_KEY: "sk-ant-operator",
  HF_OPENAI_API_KEY: "sk-openai-operator",
};

/** The template as track B ships it, narrowed to what these steps read. */
const ENV_EXAMPLE = [
  "HF_PROCESS=web",
  "HF_BUILD_SHA=dev-0000000",
  ...EXPECTED_ENV_KEYS.map((key) => `${key}=`),
].join("\n");

const PROD_COMPOSE = `x-app: &app
  image: \${DOCKER_IMAGE:-__APP_NAME__}:\${SOURCE_COMMIT:-latest}
  build:
    args:
      SOURCE_COMMIT: \${SOURCE_COMMIT:-}
services:
  web:
    <<: *app
    environment:
      HF_PROCESS: web
      HF_BUILD_SHA: \${SOURCE_COMMIT:-}
${EXPECTED_ENV_KEYS.map((key) => `      ${key}: \${${key}}`).join("\n")}
`;

const INSTALLATIONS = {
  total_count: 2,
  installations: [
    { id: 1, app_id: 10, app_slug: "coolify" },
    { id: 2, app_id: 11, app_slug: "hyperfixation-bump" },
  ],
};

interface RouteOptions {
  /** `main`'s sha on an existing repository; `undefined` means there is no such repository. */
  repoSha?: string;
  projects?: unknown[];
  /** The project's environments; defaults to the `production` one every project starts with. */
  environments?: unknown[];
  applications?: unknown[];
  /** The database's backup schedules; defaults to none, as a box that has never run `hf new`. */
  backups?: unknown[];
  langfuseProjects?: unknown[];
  dnsRecords?: unknown[];
  deployment?: { status: string };
  /** The Sentry project is already there, so the keys request answers it outright. */
  sentryExists?: boolean;
}

/** Nothing exists on any provider yet, unless an option says otherwise. */
function routes(options: RouteOptions = {}): StubRoute[] {
  const repoName = (name: string): unknown => ({
    full_name: `${OWNER}/${name}`,
    private: true,
    default_branch: "main",
  });

  return [
    // github
    options.repoSha === undefined
      ? { spec: "github", method: "get", url: `${GITHUB}/repos/{owner}/{repo}`, status: 404, json: {} }
      : { spec: "github", method: "get", url: `${GITHUB}/repos/{owner}/{repo}`, json: repoName("x") },
    {
      spec: "github",
      method: "get",
      url: `${GITHUB}/users/{username}`,
      json: { login: OWNER, type: "User" },
    },
    { spec: "github", method: "post", url: `${GITHUB}/user/repos`, status: 201, json: repoName("x") },
    {
      spec: "github",
      method: "get",
      url: `${GITHUB}/repos/{owner}/{repo}/git/ref/heads/main`,
      json: { ref: "refs/heads/main", object: { sha: options.repoSha ?? HEAD_SHA, type: "commit" } },
    },
    { spec: "github", method: "get", url: `${GITHUB}/user/installations`, json: INSTALLATIONS },
    {
      spec: "github",
      method: "get",
      url: `${GITHUB}/user/installations/{installation_id}/repositories`,
      // `all`, so the fixture does not have to name a repository whose name each test generates.
      json: { total_count: 0, repository_selection: "all", repositories: [] },
    },
    // coolify
    {
      spec: "coolify",
      method: "get",
      url: `${COOLIFY}/api/v1/s3-storages`,
      json: [{ uuid: "s3-1", name: "hetzner-backups", bucket: "hf", region: "fsn1", is_usable: true }],
    },
    {
      spec: "coolify",
      method: "get",
      url: `${COOLIFY}/api/v1/databases/{uuid}/backups`,
      json: options.backups ?? [],
    },
    { spec: "coolify", method: "post", url: `${COOLIFY}/api/v1/databases/{uuid}/backups`, json: { uuid: "backup-1" } },
    {
      spec: "coolify",
      method: "patch",
      url: `${COOLIFY}/api/v1/databases/{uuid}/backups/{scheduled_backup_uuid}`,
      json: { message: "updated" },
    },
    { spec: "coolify", method: "get", url: `${COOLIFY}/api/v1/projects`, json: options.projects ?? [] },
    { spec: "coolify", method: "post", url: `${COOLIFY}/api/v1/projects`, json: { uuid: "project-1" } },
    {
      spec: "coolify",
      method: "get",
      url: `${COOLIFY}/api/v1/projects/{uuid}/environments`,
      json: options.environments ?? [{ uuid: "environment-1", name: "production" }],
    },
    {
      spec: "coolify",
      method: "post",
      url: `${COOLIFY}/api/v1/projects/{uuid}/environments`,
      status: 201,
      json: { uuid: "environment-2" },
    },
    {
      spec: "coolify",
      method: "get",
      url: `${COOLIFY}/api/v1/applications`,
      json: options.applications ?? [],
    },
    {
      spec: "coolify",
      method: "post",
      url: `${COOLIFY}/api/v1/applications/private-github-app`,
      json: { uuid: "application-1" },
    },
    { spec: "coolify", method: "patch", url: `${COOLIFY}/api/v1/applications/{uuid}/envs/bulk`, json: [] },
    {
      spec: "coolify",
      method: "post",
      url: `${COOLIFY}/api/v1/deploy`,
      json: {
        deployments: [
          { message: "queued", resource_uuid: "application-1", deployment_uuid: "deployment-1" },
        ],
      },
    },
    {
      spec: "coolify",
      method: "get",
      url: `${COOLIFY}/api/v1/deployments/{uuid}`,
      json: { deployment_uuid: "deployment-1", status: options.deployment?.status ?? "finished" },
    },
    // sentry: a 404 that steps aside is what makes the first run create the project
    ...(options.sentryExists === true
      ? []
      : [
          {
            spec: "sentry" as const,
            method: "get" as const,
            url: `${SENTRY}/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/keys/`,
            status: 404,
            json: {},
            once: true,
          },
        ]),
    {
      spec: "sentry",
      method: "get",
      url: `${SENTRY}/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/keys/`,
      json: [{ id: "k1", name: "Default", dsn: { public: DSN } }],
    },
    {
      spec: "sentry",
      method: "post",
      url: `${SENTRY}/api/0/organizations/{organization_id_or_slug}/projects/`,
      status: 201,
      json: { id: "1", slug: "app", name: "app" },
    },
    // langfuse
    {
      spec: "langfuse",
      method: "get",
      url: `${LANGFUSE}/api/public/projects`,
      json: { data: options.langfuseProjects ?? [] },
    },
    { spec: "langfuse", method: "post", url: `${LANGFUSE}/api/public/projects`, json: { id: "lp1" } },
    {
      spec: "langfuse",
      method: "post",
      url: `${LANGFUSE}/api/public/projects/{projectId}/apiKeys`,
      json: { id: "lk1", publicKey: "pk-lf-1", secretKey: "sk-lf-1" },
    },
    // cloudflare
    {
      spec: "cloudflare",
      method: "get",
      url: `${CLOUDFLARE}/zones/{zone_id}/dns_records`,
      json: { success: true, errors: [], result: options.dnsRecords ?? [] },
    },
    {
      spec: "cloudflare",
      method: "post",
      url: `${CLOUDFLARE}/zones/{zone_id}/dns_records`,
      status: 201,
      json: { success: true, errors: [], result: { id: "record-1" } },
    },
  ];
}

const harness = createOpenApiHarness(routes());

const admin = new URL(ADMIN_URL);
const clusterAdmin: AdminCredentials = {
  user: decodeURIComponent(admin.username),
  password: decodeURIComponent(admin.password),
  database: decodeURIComponent(admin.pathname.slice(1)),
};

const provisioned: string[] = [];
const tempDirs: string[] = [];
let statusHosts: string[] = [];

/** A fresh app per test; the cluster is shared with every other suite. */
function appName(): string {
  const name = `cli_e3_${randomBytes(4).toString("hex")}`;
  provisioned.push(name);
  return name;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-cloud-steps-"));
  tempDirs.push(dir);
  return dir;
}

/** A template checkout for `fetchTemplate` to copy, with both placeholders in it. */
async function templateFixture(options: { extraDeclared?: string } = {}): Promise<string> {
  const dir = path.join(await tempDir(), "template");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, TEMPLATE_MARKER), "placeholders:\n");
  await writeFile(path.join(dir, "package.json"), '{ "name": "__APP_NAME__" }\n');
  await writeFile(path.join(dir, "src", "hyperfixation.ts"), 'name: "__APP_NAME__",\n');
  await writeFile(
    path.join(dir, ".env.example"),
    options.extraDeclared === undefined ? ENV_EXAMPLE : `${ENV_EXAMPLE}\n${options.extraDeclared}=\n`,
  );
  await writeFile(path.join(dir, "docker-compose.prod.yml"), PROD_COMPOSE);
  return dir;
}

interface CommandCall {
  command: "migrate" | "bootstrap" | "status-token";
  dir: string;
  env: Record<string, string>;
  email?: string;
  budgetUsd?: string;
}

function recordingCommands(calls: CommandCall[]): CloudCommands {
  return {
    migrate: async ({ dir, env }) => {
      calls.push({ command: "migrate", dir, env });
    },
    bootstrap: async ({ dir, env, email, budgetUsd }) => {
      calls.push({ command: "bootstrap", dir, env, email, budgetUsd });
    },
    statusToken: async ({ dir, env }) => {
      calls.push({ command: "status-token", dir, env });
      return { read: "read-token", write: "write-token" };
    },
  };
}

interface Fixture {
  context: TestStepContext;
  runner: LocalRunner;
  calls: CommandCall[];
  close(): Promise<void>;
}

/**
 * A step context over the real cluster: `createLocalRunner`'s tunnel names the test's Postgres, so
 * the database step provisions for real and the coolify step gets a genuine address to hand the
 * app's own commands.
 */
async function fixture(options: {
  name: string;
  state: AppStateStore;
  workspace: string;
  config?: OperatorConfig;
  template?: string;
  /** True when the app directory already holds a commit — a rerun, or a lost state file. */
  committed?: boolean;
}): Promise<Fixture> {
  const calls: CommandCall[] = [];
  const runner = createLocalRunner({ tunnelPort: Number(admin.port) });
  const template = options.template ?? (await templateFixture());

  let committed = options.committed ?? false;
  const exec = createRecordingExec((call) => {
    if (isGit(call, "commit")) {
      committed = true;
      return {};
    }
    if (isGit(call, "rev-parse")) {
      return committed ? { code: 0, stdout: `${HEAD_SHA}\n` } : { code: 1 };
    }
    // No `origin` yet, so the repo step adds one rather than rewriting it.
    if (isGit(call, "remote") && call.args[1] === "get-url") return { code: 1 };
    return undefined;
  });

  let database: Database | undefined;
  const context = createStepContext({
    dir: path.join(options.workspace, options.name),
    state: options.state,
    names: deriveNames(options.name),
    config: options.config ?? CONFIG,
    exec: exec.exec,
    fetchTemplate: async (_source, dir) => {
      await cp(template, dir, { recursive: true });
      return dir;
    },
    email: "admin@hf.test",
    budgetUsd: "25",
    commands: recordingCommands(calls),
    database: async () => {
      database ??= await openDatabase(runner, { admin: clusterAdmin });
      return database;
    },
  });

  return {
    context,
    runner,
    calls,
    close: async () => {
      await database?.close();
    },
  };
}

/**
 * Marks steps 1-7 done and records what the later ones read out of the state.
 *
 * `langfuse: false` is the Hobby-plan shape: the step ran, recorded itself and provisioned no key.
 */
async function seedUpstream(
  state: AppStateStore,
  name: string,
  options: { langfuse?: boolean } = {},
): Promise<void> {
  const upstream: StepName[] = [
    "template",
    "install",
    "repo",
    "backup",
    "sentry",
    "langfuse",
    "dns",
  ];
  for (const step of upstream) await state.markDone(step);
  await state.patch({
    repo: `${OWNER}/${name}`,
    sentryDsn: DSN,
    ...(options.langfuse === false
      ? {}
      : { langfuse: { publicKey: "pk-lf-1", secretKey: "sk-lf-1" } }),
  });
}

/** The app directory as the template step leaves it, for a test that starts after it. */
async function appDir(
  workspace: string,
  name: string,
  options: { extraDeclared?: string } = {},
): Promise<void> {
  const dir = path.join(workspace, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), `{ "name": "${deriveNames(name).appName}" }\n`);
  await writeFile(
    path.join(dir, ".env.example"),
    options.extraDeclared === undefined ? ENV_EXAMPLE : `${ENV_EXAMPLE}\n${options.extraDeclared}=\n`,
  );
  await writeFile(path.join(dir, "docker-compose.prod.yml"), PROD_COMPOSE);
}

function requests(): string[] {
  return harness.requests.map(
    (request) => `${request.spec} ${request.method} ${request.operationPath}`,
  );
}

/** The requests that changed something; a rerun of a finished app makes none. */
function writes(): string[] {
  return requests().filter((line) => !line.includes(" GET "));
}

function envBody(index = 0): { key: string; value: string }[] {
  const patches = harness.requests.filter(
    (request) => request.operationPath === "/applications/{uuid}/envs/bulk",
  );
  return (patches[index]!.body as { data: { key: string; value: string }[] }).data;
}

function useRoutes(options: RouteOptions): void {
  harness.server.use(...routes(options).map(harness.handler));
}

/** `CLOUD_STEPS` up to and including `database`, for the one case that must stop there. */
const THROUGH_DATABASE: readonly Step<CloudStepContext>[] = CLOUD_STEPS.slice(0, 8);

beforeAll(() => {
  harness.server.listen({ onUnhandledRequest: "error" });
});

beforeEach(() => {
  statusHosts = [];
  // Not an OpenAPI-documented provider: the app's own status endpoint, on whatever host the test's
  // app name derives.
  harness.server.use(
    http.get("*/api/status", ({ request }) => {
      statusHosts.push(new URL(request.url).host);
      if (request.headers.get("authorization") !== "Bearer read-token") {
        return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      return HttpResponse.json({ applicationVersion: HEAD_SHA });
    }),
  );
});

afterEach(() => {
  harness.server.resetHandlers();
  const violations = harness.takeViolations();
  harness.reset();
  expect(violations).toEqual([]);
});

afterAll(async () => {
  harness.server.close();
  await asRole(ADMIN_URL, async (cluster) => {
    for (const name of provisioned) {
      await cluster.query(`DROP DATABASE IF EXISTS "hf_${name}" WITH (FORCE)`);
      for (const suffix of ["", "_migrator", "_ro"]) {
        await cluster.query(`DROP ROLE IF EXISTS "hf_${name}${suffix}"`);
      }
    }
  });
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
}, 60_000);

describe("a cloud hf new, all ten steps", () => {
  it("issues every provider request in the documented order and writes every state key", async () => {
    const name = appName();
    const workspace = await tempDir();
    const state = await openAppState(name, { dir: await tempDir() });
    const run = await fixture({ name, state, workspace });

    try {
      const result = await runSteps(CLOUD_STEPS, run.context);

      expect(result.ran).toEqual([
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
      ]);
      expect(requests()).toEqual([
        "github GET /repos/{owner}/{repo}",
        "github GET /users/{username}",
        "github POST /user/repos",
        "github GET /user/installations",
        "github GET /user/installations/{installation_id}/repositories",
        "github GET /user/installations/{installation_id}/repositories",
        "coolify GET /s3-storages",
        "coolify GET /databases/{uuid}/backups",
        "coolify POST /databases/{uuid}/backups",
        "sentry GET /api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/keys/",
        "sentry POST /api/0/organizations/{organization_id_or_slug}/projects/",
        "sentry GET /api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/keys/",
        "langfuse GET /api/public/projects",
        "langfuse POST /api/public/projects",
        "langfuse POST /api/public/projects/{projectId}/apiKeys",
        "cloudflare GET /zones/{zone_id}/dns_records",
        "cloudflare POST /zones/{zone_id}/dns_records",
        "coolify GET /projects",
        "coolify POST /projects",
        "coolify GET /projects/{uuid}/environments",
        "coolify GET /applications",
        "coolify POST /applications/private-github-app",
        "coolify PATCH /applications/{uuid}/envs/bulk",
        "coolify POST /deploy",
        "coolify GET /deployments/{uuid}",
      ]);

      // One forward for the whole run: `database` opens the cluster and `coolify` reuses it.
      expect(run.runner.tunnels).toEqual([5432]);

      // Per service and never `domains`: a dockercompose application refuses the latter outright,
      // which is how the first X1 run died at step 9 with an unreadable 422.
      const created = harness.requests.find(
        (request) => request.operationPath === "/applications/private-github-app",
      )!.body as Record<string, unknown>;
      expect(created).toMatchObject({
        build_pack: "dockercompose",
        docker_compose_location: COMPOSE_LOCATION,
        docker_compose_domains: [
          { name: COMPOSE_DOMAIN_SERVICE, domain: `https://${name}.${BASE_DOMAIN}` },
        ],
      });
      expect(created.domains).toBeUndefined();

      expect(envBody().map((env) => env.key)).toEqual(EXPECTED_ENV_KEYS);
      expect(statusHosts).toEqual([`${name}.${BASE_DOMAIN}`]);

      expect(run.calls.map((call) => call.command)).toEqual([
        "migrate",
        "bootstrap",
        "status-token",
      ]);
      expect(run.calls[1]).toMatchObject({ email: "admin@hf.test", budgetUsd: "25" });

      expect(state.state).toMatchObject({
        repo: `${OWNER}/${name}`,
        coolify: {
          projectUuid: "project-1",
          appUuid: "application-1",
          envsSecretsHash: secretsHash(state.state),
        },
        sentryDsn: DSN,
        langfuse: { publicKey: "pk-lf-1", secretKey: "sk-lf-1" },
        statusTokens: { read: "read-token", write: "write-token" },
        lastDeployedSha: HEAD_SHA,
      });
      expect(state.state.betterAuthSecret).toHaveLength(43);
      expect(state.state.database?.applicationPassword).toBeTypeOf("string");
      // A box with one usable S3 storage and no schedule yet leaves the operator nothing to do
      // about backups: the dump goes off the box and there is no second schedule to look for.
      expect(run.context.checklist.join("\n")).not.toContain("backup");
    } finally {
      await run.close();
    }
  }, 60_000);

  it("carries the app's own environment into the tunnel, pointed at the forward and not at a .env", async () => {
    const name = appName();
    const workspace = await tempDir();
    const state = await openAppState(name, { dir: await tempDir() });
    const run = await fixture({ name, state, workspace });

    try {
      await runSteps(CLOUD_STEPS, run.context);

      const overlay = run.calls[0]!.env;
      expect(Object.keys(overlay).sort()).toEqual([...EXPECTED_ENV_KEYS].sort());
      expect(overlay.DATABASE_URL).toContain(`@127.0.0.1:${admin.port}/hf_${name}`);
      expect(overlay.MIGRATOR_DATABASE_URL).toContain(`hf_${name}_migrator`);
      expect(overlay.APP_URL).toBe(`https://${name}.${BASE_DOMAIN}`);

      // What Coolify was sent instead: the hostname the app's own containers resolve.
      const sent = new Map(envBody().map((env) => [env.key, env.value]));
      expect(sent.get("DATABASE_URL")).toContain("@postgres-uuid:5432/");
      expect(sent.get("APP_URL")).toBe(`https://${name}.${BASE_DOMAIN}`);
      expect(sent.get("ANTHROPIC_API_KEY")).toBe("sk-ant-operator");
      expect(sent.get("SENTRY_DSN")).toBe(DSN);
    } finally {
      await run.close();
    }
  }, 60_000);

  it("issues nothing at all on a second run of a finished app", async () => {
    const name = appName();
    const workspace = await tempDir();
    const stateDir = await tempDir();
    const first = await fixture({ name, state: await openAppState(name, { dir: stateDir }), workspace });
    try {
      await runSteps(CLOUD_STEPS, first.context);
    } finally {
      await first.close();
    }
    harness.reset();
    statusHosts = [];

    const second = await fixture({
      name,
      state: await openAppState(name, { dir: stateDir }),
      workspace,
      committed: true,
    });
    try {
      const result = await runSteps(CLOUD_STEPS, second.context);

      expect(result.ran).toEqual([]);
      expect(result.invalidated).toEqual([]);
      expect(requests()).toEqual([]);
      expect(second.runner.tunnels).toEqual([]);
      expect(statusHosts).toEqual([]);
    } finally {
      await second.close();
    }
  }, 90_000);

  it("re-PATCHes the new password on a cold run, and creates nothing it can find", async () => {
    const name = appName();
    const workspace = await tempDir();
    const warm = await openAppState(name, { dir: await tempDir() });
    const first = await fixture({ name, state: warm, workspace });
    try {
      await runSteps(CLOUD_STEPS, first.context);
    } finally {
      await first.close();
    }
    const firstPassword = warm.state.database?.applicationPassword;

    harness.reset();
    useRoutes({
      repoSha: HEAD_SHA,
      projects: [{ uuid: "project-1", name }],
      applications: [{ uuid: "application-1", name }],
      langfuseProjects: [{ id: "lp1", name: deriveNames(name).appName }],
      backups: [{ uuid: "backup-1", databases_to_backup: deriveNames(name).databaseName }],
      dnsRecords: [{ id: "record-1", type: "A", name: `${name}.${BASE_DOMAIN}`, content: BOX_IP }],
      sentryExists: true,
    });

    // The state file is gone; the roles are not. Every password is regenerated, and the deployed
    // app holds the old one until the PATCH and the redeploy below. The old app directory is
    // moved away, as the template step's refusal to adopt it on a first run tells the operator.
    await rm(path.join(workspace, name), { recursive: true, force: true });
    const cold = await openAppState(name, { dir: await tempDir() });
    const second = await fixture({ name, state: cold, workspace, committed: true });
    try {
      await runSteps(CLOUD_STEPS, second.context);

      expect(second.context.rotated).toBe(true);
      // Only what a cold run cannot look up: Langfuse hands a secret key back once. The backup
      // schedule is found in the database's list and reconciled, not registered a second time.
      expect(writes()).toEqual([
        "coolify PATCH /databases/{uuid}/backups/{scheduled_backup_uuid}",
        "langfuse POST /api/public/projects/{projectId}/apiKeys",
        "coolify PATCH /applications/{uuid}/envs/bulk",
        "coolify POST /deploy",
      ]);

      const sent = new Map(envBody().map((env) => [env.key, env.value]));
      expect(cold.state.database?.applicationPassword).not.toBe(firstPassword);
      expect(sent.get("DATABASE_URL")).toContain(
        encodeURIComponent(cold.state.database!.applicationPassword!),
      );
      expect(sent.get("DATABASE_URL")).not.toContain(encodeURIComponent(firstPassword!));
    } finally {
      await second.close();
    }
  }, 90_000);
});

describe("the coolify and deploy steps on their own", () => {
  let workspace: string;
  let stateDir: string;
  let name: string;

  beforeEach(async () => {
    workspace = await tempDir();
    stateDir = await tempDir();
    name = appName();
    await appDir(workspace, name);
  });

  const resumed = async (options: { committed?: boolean } = {}): Promise<Fixture> => {
    const state = await openAppState(name, { dir: stateDir });
    await seedUpstream(state, name);
    return await fixture({ name, state, workspace, committed: options.committed ?? true });
  };

  it("resumes at the step that failed, with no request from an earlier one", async () => {
    harness.server.use(
      harness.handler({
        spec: "coolify",
        method: "patch",
        url: `${COOLIFY}/api/v1/applications/{uuid}/envs/bulk`,
        status: 500,
        json: { message: "boom" },
      }),
    );

    const first = await resumed();
    try {
      await expect(runSteps(CLOUD_STEPS, first.context)).rejects.toThrow(/HTTP 500/);
      expect(first.context.state.isDone("database")).toBe(true);
      expect(first.context.state.isDone("coolify")).toBe(false);
    } finally {
      await first.close();
    }

    harness.reset();
    useRoutes({
      projects: [{ uuid: "project-1", name }],
      applications: [{ uuid: "application-1", name }],
    });

    const second = await resumed();
    try {
      const result = await runSteps(CLOUD_STEPS, second.context);

      expect(result.ran).toEqual(["coolify", "deploy"]);
      // The project and the application are found, not created a second time.
      expect(writes()).toEqual([
        "coolify PATCH /applications/{uuid}/envs/bulk",
        "coolify POST /deploy",
      ]);
    } finally {
      await second.close();
    }
  }, 90_000);

  it("creates the production environment when the project has none, and names it in the application", async () => {
    harness.reset();
    useRoutes({ environments: [{ uuid: "environment-0", name: "staging" }] });

    const run = await resumed();
    try {
      const result = await runSteps(CLOUD_STEPS, run.context);

      expect(result.ran).toContain("coolify");
      const order = writes().filter((line) =>
        ["POST /projects", "POST /projects/{uuid}/environments", "POST /applications/"].some(
          (write) => line.startsWith(`coolify ${write}`),
        ),
      );
      expect(order).toEqual([
        "coolify POST /projects",
        "coolify POST /projects/{uuid}/environments",
        "coolify POST /applications/private-github-app",
      ]);

      const environment = harness.requests.find(
        (request) => request.operationPath === "/projects/{uuid}/environments" && request.method === "POST",
      )!;
      expect(environment.body).toEqual({ name: "production" });
      expect(environment.pathname).toBe("/api/v1/projects/project-1/environments");

      const application = harness.requests.find(
        (request) => request.operationPath === "/applications/private-github-app",
      )!.body as Record<string, unknown>;
      expect(application).toMatchObject({
        environment_name: "production",
        environment_uuid: "environment-2",
      });
    } finally {
      await run.close();
    }
  }, 90_000);

  it("uses the production environment it finds, and creates none", async () => {
    const run = await resumed();
    try {
      await runSteps(CLOUD_STEPS, run.context);

      expect(writes()).not.toContain("coolify POST /projects/{uuid}/environments");
      const application = harness.requests.find(
        (request) => request.operationPath === "/applications/private-github-app",
      )!.body as Record<string, unknown>;
      expect(application.environment_uuid).toBe("environment-1");
    } finally {
      await run.close();
    }
  }, 90_000);

  it("finds the project it created when the state write that recorded it never landed", async () => {
    const store = await openAppState(name, { dir: stateDir });
    await seedUpstream(store, name);
    const crashing: AppStateStore = {
      file: store.file,
      get state() {
        return store.state;
      },
      isDone: (step) => store.isDone(step),
      markDone: async (step) => await store.markDone(step),
      clearDone: async (step) => await store.clearDone(step),
      patch: async (changes) => {
        if (changes.coolify?.projectUuid !== undefined) {
          throw new Error("the state file could not be written");
        }
        await store.patch(changes);
      },
    };

    const first = await fixture({ name, state: crashing, workspace, committed: true });
    try {
      await expect(runSteps(CLOUD_STEPS, first.context)).rejects.toThrow(
        /state file could not be written/,
      );
      expect(writes()).toEqual(["coolify POST /projects"]);
    } finally {
      await first.close();
    }

    harness.reset();
    useRoutes({ projects: [{ uuid: "project-1", name }] });

    const second = await resumed();
    try {
      await runSteps(CLOUD_STEPS, second.context);

      expect(requests()).toContain("coolify GET /projects");
      expect(writes()).not.toContain("coolify POST /projects");
    } finally {
      await second.close();
    }
  }, 90_000);

  it("re-PATCHes after a rotation whose redeploy failed two runs ago", async () => {
    const first = await resumed();
    try {
      await runSteps(CLOUD_STEPS, first.context);
    } finally {
      await first.close();
    }

    harness.reset();
    useRoutes({
      projects: [{ uuid: "project-1", name }],
      applications: [{ uuid: "application-1", name }],
      deployment: { status: "failed" },
    });

    // A rotation, then a deploy that fails: `coolify` is recorded again but `deploy` is not.
    const rotatedState = await openAppState(name, { dir: await tempDir() });
    await seedUpstream(rotatedState, name);
    const second = await fixture({ name, state: rotatedState, workspace, committed: true });
    try {
      await expect(runSteps(CLOUD_STEPS, second.context)).rejects.toThrow(/ended failed/);
      expect(second.context.rotated).toBe(true);
      expect(rotatedState.isDone("coolify")).toBe(true);
      expect(rotatedState.isDone("deploy")).toBe(false);
    } finally {
      await second.close();
    }

    harness.reset();
    useRoutes({
      projects: [{ uuid: "project-1", name }],
      applications: [{ uuid: "application-1", name }],
    });

    const third = await fixture({ name, state: rotatedState, workspace, committed: true });
    try {
      const result = await runSteps(CLOUD_STEPS, third.context);

      expect(result.ran).toEqual(["deploy"]);
      expect(rotatedState.state.lastDeployedSha).toBe(HEAD_SHA);
    } finally {
      await third.close();
    }
  }, 120_000);

  it("refuses to finish a run that rotated without reaching Coolify", async () => {
    const first = await resumed();
    try {
      await runSteps(CLOUD_STEPS, first.context);
    } finally {
      await first.close();
    }

    harness.reset();
    // A cold run whose step list stops at `database`: the state file it leaves is self-consistent
    // and the deployed app is on passwords that no longer exist. Only `rotated` can tell.
    const cold = await openAppState(name, { dir: await tempDir() });
    await seedUpstream(cold, name);
    const second = await fixture({ name, state: cold, workspace, committed: true });
    try {
      const refusal = await runSteps(THROUGH_DATABASE, second.context).catch(
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(StepInvariantViolated);
      expect((refusal as Error).message).toMatch(/still holds the old ones/);
    } finally {
      await second.close();
    }
  }, 90_000);

  it("omits both provider keys when the operator configured neither", async () => {
    const config = { ...CONFIG };
    delete config.HF_ANTHROPIC_API_KEY;
    delete config.HF_OPENAI_API_KEY;

    const state = await openAppState(name, { dir: stateDir });
    await seedUpstream(state, name);
    const run = await fixture({ name, state, workspace, config, committed: true });

    try {
      await runSteps(CLOUD_STEPS, run.context);

      expect(envBody().map((env) => env.key)).toEqual(
        EXPECTED_ENV_KEYS.filter((key) => !key.endsWith("_API_KEY")),
      );
    } finally {
      await run.close();
    }
  }, 60_000);

  it("omits all three Langfuse variables when the step provisioned no keys", async () => {
    const config = { ...CONFIG };
    delete config.HF_LANGFUSE_ORG_KEY;

    const state = await openAppState(name, { dir: stateDir });
    await seedUpstream(state, name, { langfuse: false });
    const run = await fixture({ name, state, workspace, config, committed: true });

    try {
      await runSteps(CLOUD_STEPS, run.context);

      // Absent, not empty — and the drift assertion excuses them rather than refusing the PATCH.
      expect(envBody().map((env) => env.key)).toEqual(
        EXPECTED_ENV_KEYS.filter((key) => !key.startsWith("LANGFUSE_")),
      );
    } finally {
      await run.close();
    }
  }, 60_000);
});

describe("the environment drift assertion", () => {
  it("fails before a single Coolify request when .env.example declares one more name", async () => {
    const name = appName();
    const workspace = await tempDir();
    await appDir(workspace, name, { extraDeclared: "STRIPE_SECRET_KEY" });
    const state = await openAppState(name, { dir: await tempDir() });
    await seedUpstream(state, name);
    const run = await fixture({ name, state, workspace, committed: true });

    try {
      const refusal = await runSteps(CLOUD_STEPS, run.context).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(EnvDrift);
      expect((refusal as Error).message).toContain("STRIPE_SECRET_KEY");
      expect(harness.requests).toEqual([]);
    } finally {
      await run.close();
    }
  }, 60_000);

  it("agrees with the real template's own contract, compose interpolations included", async (ctx) => {
    const template = await findTemplateSource();
    if (template === undefined) ctx.skip();

    // `.env.example` equals `REQUIRED_ENV` (the template's own test asserts that), so this is the
    // adversary's finding in one line: what hf new sends is what the deployed app is declared to
    // need, minus the two the containers set and the two compose supplies.
    expect((await neededEnvNames(template as string)).sort()).toEqual(
      [...EXPECTED_ENV_KEYS].sort(),
    );
  });
});
