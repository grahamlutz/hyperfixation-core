import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADMIN_URL, asRole } from "@hyperfixation/testing";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OperatorConfig } from "../config.js";
import type { AdminCredentials, Database } from "../database.js";
import { deriveNames } from "../names.js";
import {
  runSteps,
  StepInvariantViolated,
  type CloudCommands,
  type CloudContext,
  type Step,
} from "../new-cloud.js";
import { CoolifyClient } from "../providers/coolify.js";
import { openDatabase } from "../database.js";
import { createLocalRunner, type LocalRunner } from "../runner.js";
import { openAppState, secretsHash, type AppStateStore, type StepName } from "../state.js";
import { createOpenApiHarness, type StubRoute } from "../test-support/openapi.js";
import { findTemplateSource } from "../template-source.js";
import { coolifyStep, EnvDrift, neededEnvNames } from "./coolify.js";
import { databaseStep } from "./database.js";
import { deployStep } from "./deploy.js";

const COOLIFY = "https://coolify.test";
const BASE_DOMAIN = "hf.test";
const HEAD_SHA = "1".repeat(40);

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
  HF_LANGFUSE_URL: "https://langfuse.test",
  HF_ANTHROPIC_API_KEY: "sk-ant-operator",
  HF_OPENAI_API_KEY: "sk-openai-operator",
};

/** The app as `hf new --local` leaves it: the two files the drift assertion reads. */
const ENV_EXAMPLE = ["HF_PROCESS=web", "HF_BUILD_SHA=dev-0000000", ...EXPECTED_ENV_KEYS.map((key) => `${key}=`)].join("\n");

const PROD_COMPOSE = `x-app: &app
  image: \${DOCKER_IMAGE:-demo}:\${SOURCE_COMMIT:-latest}
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

/** Nothing exists on the instance yet; a test that needs an existing resource re-registers. */
const routes = (options: {
  projects?: unknown[];
  applications?: unknown[];
  deployment?: { status: string };
} = {}): StubRoute[] => [
  { spec: "coolify", method: "get", url: `${COOLIFY}/api/v1/projects`, json: options.projects ?? [] },
  { spec: "coolify", method: "post", url: `${COOLIFY}/api/v1/projects`, json: { uuid: "project-1" } },
  {
    spec: "coolify",
    method: "get",
    url: `${COOLIFY}/api/v1/projects/{uuid}/environments`,
    json: [{ uuid: "environment-1", name: "production" }],
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
    json: { deployments: [{ message: "queued", resource_uuid: "application-1", deployment_uuid: "deployment-1" }] },
  },
  {
    spec: "coolify",
    method: "get",
    url: `${COOLIFY}/api/v1/deployments/{uuid}`,
    json: { deployment_uuid: "deployment-1", status: options.deployment?.status ?? "finished" },
  },
];

const harness = createOpenApiHarness(routes());

const admin = new URL(ADMIN_URL);
const clusterAdmin: AdminCredentials = {
  user: decodeURIComponent(admin.username),
  password: decodeURIComponent(admin.password),
  database: decodeURIComponent(admin.pathname.slice(1)),
};

const provisioned: string[] = [];
const tempDirs: string[] = [];
let statusRequests: string[] = [];
let reportedVersion: string | null = HEAD_SHA;

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

/** The app directory the `template` step would have left behind. */
async function appDir(name: string, options: { extraDeclared?: string } = {}): Promise<string> {
  const dir = path.join(await tempDir(), name);
  await mkdir(dir, { recursive: true });
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
  context: CloudContext;
  runner: LocalRunner;
  calls: CommandCall[];
  ran: StepName[];
  close(): Promise<void>;
}

function fixture(options: {
  name: string;
  dir: string;
  state: AppStateStore;
  config?: OperatorConfig;
}): Fixture {
  const calls: CommandCall[] = [];
  const ran: StepName[] = [];
  const runner = createLocalRunner({ tunnelPort: Number(admin.port) });
  const config = options.config ?? CONFIG;

  let database: Database | undefined;
  const context: CloudContext = {
    state: options.state,
    rotated: false,
    name: options.name,
    names: deriveNames(options.name),
    dir: options.dir,
    fqdn: `${options.name}.${BASE_DOMAIN}`,
    email: "admin@hf.test",
    budgetUsd: "25",
    config,
    env: {},
    coolify: new CoolifyClient({ url: COOLIFY, token: "coolify-token" }),
    runner,
    database: async () => {
      database ??= await openDatabase(runner, { admin: clusterAdmin });
      return database;
    },
    commands: recordingCommands(calls),
    headSha: async () => await Promise.resolve(HEAD_SHA),
    fetch: (input, init) => globalThis.fetch(input, init),
    now: () => Date.now(),
    sleep: async () => await Promise.resolve(),
    io: { out: () => undefined },
  };

  return {
    context,
    runner,
    calls,
    ran,
    close: async () => {
      await database?.close();
    },
  };
}

/** PR 2's seven steps, each recording what the later ones read out of the state. */
function upstreamSteps(ran: StepName[], repo: string): Step<CloudContext>[] {
  const stub = (name: StepName, run?: (context: CloudContext) => Promise<void>): Step<CloudContext> => ({
    name,
    run: async (context) => {
      ran.push(name);
      await run?.(context);
    },
  });

  return [
    stub("template"),
    stub("install"),
    stub("repo", async (context) => {
      await context.state.patch({ repo });
    }),
    stub("backup"),
    stub("sentry", async (context) => {
      await context.state.patch({ sentryDsn: "https://key@o0.ingest.sentry.io/1" });
    }),
    stub("langfuse", async (context) => {
      await context.state.patch({ langfuse: { publicKey: "pk-lf-1", secretKey: "sk-lf-1" } });
    }),
    stub("dns"),
  ];
}

function allSteps(ran: StepName[], repo: string): Step<CloudContext>[] {
  return [...upstreamSteps(ran, repo), databaseStep(), coolifyStep(), deployStep()];
}

/** The requests that changed something on the instance; a rerun of a finished app makes none. */
function writes(): string[] {
  return harness.requests
    .filter((request) => request.method !== "GET")
    .map((request) => `${request.method} ${request.operationPath}`);
}

function paths(): string[] {
  return harness.requests.map((request) => `${request.method} ${request.operationPath}`);
}

function envBody(index = 0): { key: string; value: string }[] {
  const patches = harness.requests.filter((request) => request.method === "PATCH");
  return (patches[index]!.body as { data: { key: string; value: string }[] }).data;
}

beforeAll(() => {
  harness.server.listen({ onUnhandledRequest: "error" });
});

beforeEach(() => {
  statusRequests = [];
  reportedVersion = HEAD_SHA;
  // Not an OpenAPI-documented provider: the app's own status endpoint, on whatever host the
  // test's app name derives.
  harness.server.use(
    http.get("*/api/status", ({ request }) => {
      statusRequests.push(new URL(request.url).host);
      if (request.headers.get("authorization") !== "Bearer read-token") {
        return HttpResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      return HttpResponse.json({ applicationVersion: reportedVersion });
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

describe("a cloud hf new, from the first step to the deploy", () => {
  it("issues the ten steps' requests in order and writes every state key", async () => {
    const name = appName();
    const dir = await appDir(name);
    const state = await openAppState(name, { dir: await tempDir() });
    const run = fixture({ name, dir, state });

    try {
      const result = await runSteps(allSteps(run.ran, `grahamlutz/${name}`), run.context);

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
      expect(paths()).toEqual([
        "GET /projects",
        "POST /projects",
        "GET /projects/{uuid}/environments",
        "GET /applications",
        "POST /applications/private-github-app",
        "PATCH /applications/{uuid}/envs/bulk",
        "POST /deploy",
        "GET /deployments/{uuid}",
      ]);

      // One forward for the whole run: `database` opens the cluster and `coolify` reuses it.
      expect(run.runner.tunnels).toEqual([5432]);

      expect(envBody().map((env) => env.key)).toEqual(EXPECTED_ENV_KEYS);
      expect(statusRequests).toEqual([`${name}.${BASE_DOMAIN}`]);

      expect(run.calls.map((call) => call.command)).toEqual([
        "migrate",
        "bootstrap",
        "status-token",
      ]);
      expect(run.calls[1]).toMatchObject({ email: "admin@hf.test", budgetUsd: "25" });

      expect(state.state).toMatchObject({
        repo: `grahamlutz/${name}`,
        coolify: {
          projectUuid: "project-1",
          appUuid: "application-1",
          envsSecretsHash: secretsHash(state.state),
        },
        sentryDsn: "https://key@o0.ingest.sentry.io/1",
        langfuse: { publicKey: "pk-lf-1", secretKey: "sk-lf-1" },
        statusTokens: { read: "read-token", write: "write-token" },
        lastDeployedSha: HEAD_SHA,
      });
      expect(state.state.betterAuthSecret).toHaveLength(43);
      expect(state.state.database?.applicationPassword).toBeTypeOf("string");
    } finally {
      await run.close();
    }
  }, 60_000);

  it("carries the app's own environment into the tunnel, pointed at the forward and not at a .env", async () => {
    const name = appName();
    const dir = await appDir(name);
    const state = await openAppState(name, { dir: await tempDir() });
    const run = fixture({ name, dir, state });

    try {
      await runSteps(allSteps(run.ran, `grahamlutz/${name}`), run.context);

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
    } finally {
      await run.close();
    }
  }, 60_000);

  it("issues nothing at all on a second run of a finished app", async () => {
    const name = appName();
    const dir = await appDir(name);
    const stateDir = await tempDir();
    const first = fixture({ name, dir, state: await openAppState(name, { dir: stateDir }) });
    try {
      await runSteps(allSteps(first.ran, `grahamlutz/${name}`), first.context);
    } finally {
      await first.close();
    }
    harness.reset();
    statusRequests = [];

    const second = fixture({ name, dir, state: await openAppState(name, { dir: stateDir }) });
    try {
      const result = await runSteps(allSteps(second.ran, `grahamlutz/${name}`), second.context);

      expect(result.ran).toEqual([]);
      expect(result.invalidated).toEqual([]);
      expect(paths()).toEqual([]);
      expect(second.runner.tunnels).toEqual([]);
      expect(second.runner.commands).toEqual([]);
      expect(statusRequests).toEqual([]);
    } finally {
      await second.close();
    }
  }, 90_000);

  it("resumes at the step that failed, with no request from an earlier one", async () => {
    const name = appName();
    const dir = await appDir(name);
    const stateDir = await tempDir();

    harness.server.use(
      harness.handler({
        spec: "coolify",
        method: "patch",
        url: `${COOLIFY}/api/v1/applications/{uuid}/envs/bulk`,
        status: 500,
        json: { message: "boom" },
      }),
    );

    const first = fixture({ name, dir, state: await openAppState(name, { dir: stateDir }) });
    try {
      await expect(runSteps(allSteps(first.ran, `grahamlutz/${name}`), first.context)).rejects.toThrow(
        /HTTP 500/,
      );
      expect(first.ran).toEqual(["template", "install", "repo", "backup", "sentry", "langfuse", "dns"]);
    } finally {
      await first.close();
    }

    harness.reset();
    harness.server.use(
      ...routes({
        projects: [{ uuid: "project-1", name }],
        applications: [{ uuid: "application-1", name }],
      }).map(harness.handler),
    );

    const second = fixture({ name, dir, state: await openAppState(name, { dir: stateDir }) });
    try {
      const result = await runSteps(allSteps(second.ran, `grahamlutz/${name}`), second.context);

      expect(result.ran).toEqual(["coolify", "deploy"]);
      expect(result.skipped).toEqual([
        "template",
        "install",
        "repo",
        "backup",
        "sentry",
        "langfuse",
        "dns",
        "database",
      ]);
      // The project and the application are found, not created a second time.
      expect(writes()).toEqual([
        "PATCH /applications/{uuid}/envs/bulk",
        "POST /deploy",
      ]);
    } finally {
      await second.close();
    }
  }, 90_000);

  it("re-PATCHes the new password on a cold run, and creates nothing twice", async () => {
    const name = appName();
    const dir = await appDir(name);
    const warm = await openAppState(name, { dir: await tempDir() });
    const first = fixture({ name, dir, state: warm });
    try {
      await runSteps(allSteps(first.ran, `grahamlutz/${name}`), first.context);
    } finally {
      await first.close();
    }
    const firstPassword = warm.state.database?.applicationPassword;

    harness.reset();
    harness.server.use(
      ...routes({
        projects: [{ uuid: "project-1", name }],
        applications: [{ uuid: "application-1", name }],
      }).map(harness.handler),
    );

    // The state file is gone; the roles are not. Every password is regenerated, and the deployed
    // app holds the old one until the PATCH and the redeploy below.
    const cold = await openAppState(name, { dir: await tempDir() });
    const second = fixture({ name, dir, state: cold });
    try {
      await runSteps(allSteps(second.ran, `grahamlutz/${name}`), second.context);

      expect(second.context.rotated).toBe(true);
      expect(writes()).toEqual(["PATCH /applications/{uuid}/envs/bulk", "POST /deploy"]);

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

  it("finds the project it created when the state write that recorded it never landed", async () => {
    const name = appName();
    const dir = await appDir(name);
    const stateDir = await tempDir();

    const store = await openAppState(name, { dir: stateDir });
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

    const first = fixture({ name, dir, state: crashing });
    try {
      await expect(runSteps(allSteps(first.ran, `grahamlutz/${name}`), first.context)).rejects.toThrow(
        /state file could not be written/,
      );
      expect(writes()).toEqual(["POST /projects"]);
    } finally {
      await first.close();
    }

    harness.reset();
    harness.server.use(
      ...routes({ projects: [{ uuid: "project-1", name }] }).map(harness.handler),
    );

    const second = fixture({ name, dir, state: await openAppState(name, { dir: stateDir }) });
    try {
      await runSteps(allSteps(second.ran, `grahamlutz/${name}`), second.context);

      expect(paths()).toContain("GET /projects");
      expect(writes()).not.toContain("POST /projects");
    } finally {
      await second.close();
    }
  }, 90_000);

  it("re-PATCHes after a rotation whose redeploy failed two runs ago", async () => {
    const name = appName();
    const dir = await appDir(name);
    const stateDir = await tempDir();

    const first = fixture({ name, dir, state: await openAppState(name, { dir: stateDir }) });
    try {
      await runSteps(allSteps(first.ran, `grahamlutz/${name}`), first.context);
    } finally {
      await first.close();
    }

    harness.reset();
    harness.server.use(
      ...routes({
        projects: [{ uuid: "project-1", name }],
        applications: [{ uuid: "application-1", name }],
        deployment: { status: "failed" },
      }).map(harness.handler),
    );

    // A rotation, then a deploy that fails: `coolify` is recorded again but `deploy` is not.
    const rotating = await openAppState(name, { dir: await tempDir() });
    const second = fixture({ name, dir, state: rotating });
    try {
      await expect(runSteps(allSteps(second.ran, `grahamlutz/${name}`), second.context)).rejects.toThrow(
        /ended failed/,
      );
      expect(rotating.isDone("coolify")).toBe(true);
      expect(rotating.isDone("deploy")).toBe(false);
    } finally {
      await second.close();
    }

    harness.reset();
    harness.server.use(
      ...routes({
        projects: [{ uuid: "project-1", name }],
        applications: [{ uuid: "application-1", name }],
      }).map(harness.handler),
    );

    const third = fixture({ name, dir, state: rotating });
    try {
      const result = await runSteps(allSteps(third.ran, `grahamlutz/${name}`), third.context);

      expect(result.ran).toEqual(["deploy"]);
      expect(rotating.state.lastDeployedSha).toBe(HEAD_SHA);
    } finally {
      await third.close();
    }
  }, 120_000);

  it("refuses to finish a run that rotated without reaching Coolify", async () => {
    const name = appName();
    const dir = await appDir(name);
    const stateDir = await tempDir();

    const first = fixture({ name, dir, state: await openAppState(name, { dir: stateDir }) });
    try {
      await runSteps(allSteps(first.ran, `grahamlutz/${name}`), first.context);
    } finally {
      await first.close();
    }

    harness.reset();
    // A cold run whose step list stops at `database`: the state file it leaves is self-consistent
    // and the deployed app is on passwords that no longer exist. Only `rotated` can tell.
    const cold = await openAppState(name, { dir: await tempDir() });
    const second = fixture({ name, dir, state: cold });
    try {
      const refusal = await runSteps(
        [...upstreamSteps(second.ran, `grahamlutz/${name}`), databaseStep()],
        second.context,
      ).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(StepInvariantViolated);
      expect((refusal as Error).message).toMatch(/still holds the old ones/);
    } finally {
      await second.close();
    }
  }, 90_000);

  it("omits both provider keys when the operator configured neither", async () => {
    const name = appName();
    const dir = await appDir(name);
    const state = await openAppState(name, { dir: await tempDir() });
    const config = { ...CONFIG };
    delete config.HF_ANTHROPIC_API_KEY;
    delete config.HF_OPENAI_API_KEY;
    const run = fixture({ name, dir, state, config });

    try {
      await runSteps(allSteps(run.ran, `grahamlutz/${name}`), run.context);

      expect(envBody().map((env) => env.key)).toEqual(
        EXPECTED_ENV_KEYS.filter((key) => !key.endsWith("_API_KEY")),
      );
    } finally {
      await run.close();
    }
  }, 60_000);
});

describe("the environment drift assertion", () => {
  it("fails before a single Coolify request when .env.example declares one more name", async () => {
    const name = appName();
    const dir = await appDir(name, { extraDeclared: "STRIPE_SECRET_KEY" });
    const state = await openAppState(name, { dir: await tempDir() });
    const run = fixture({ name, dir, state });

    try {
      const refusal = await runSteps(
        allSteps(run.ran, `grahamlutz/${name}`),
        run.context,
      ).catch((error: unknown) => error);

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
    expect((await neededEnvNames(template as string)).sort()).toEqual([...EXPECTED_ENV_KEYS].sort());
  });
});
