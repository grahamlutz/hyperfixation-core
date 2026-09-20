import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { http, HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "./cli.js";
import type { OperatorConfig } from "./config.js";
import { deployApp, type DeployAppOptions } from "./deploy-app.js";
import { openAppState } from "./state.js";
import { createRecordingExec, type ExecCall } from "./test-support/cloud-step.js";
import { createOpenApiHarness, type StubRoute } from "./test-support/openapi.js";

const APP = "demo-app";
const BASE_DOMAIN = "hf.test";
const COOLIFY = "https://coolify.test";
const STATUS_URL = `https://${APP}.${BASE_DOMAIN}/api/status`;
const REPO = `grahamlutz/${APP}`;

const MAIN_SHA = "1".repeat(40);
const OTHER_SHA = "2".repeat(40);

const CONFIG: OperatorConfig = {
  HF_COOLIFY_URL: COOLIFY,
  HF_COOLIFY_TOKEN: "coolify-token",
  HF_BASE_DOMAIN: BASE_DOMAIN,
  HF_GITHUB_TOKEN: "github-token",
};

const ROUTES: StubRoute[] = [
  {
    spec: "coolify",
    method: "get",
    url: `${COOLIFY}/api/v1/applications/{uuid}/envs`,
    json: [
      { uuid: "env-1", key: "SOURCE_COMMIT", value: "", is_preview: false },
      { uuid: "env-2", key: "SOURCE_COMMIT", value: "", is_preview: true },
    ],
  },
  { spec: "coolify", method: "patch", url: `${COOLIFY}/api/v1/applications/{uuid}/envs`, json: {} },
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
    json: { deployment_uuid: "deployment-1", status: "finished" },
  },
];

const harness = createOpenApiHarness(ROUTES);
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-deploy-"));
  tempDirs.push(dir);
  return dir;
}

/** The state file as a finished `hf new` leaves it. */
async function stateDirWith(overrides: { repo?: string } = {}): Promise<string> {
  const dir = await tempDir();
  const store = await openAppState(APP, { dir });
  await store.patch({
    repo: "repo" in overrides ? overrides.repo : REPO,
    coolify: { projectUuid: "project-1", appUuid: "application-1" },
    statusTokens: { read: "read-token", write: "write-token" },
    lastDeployedSha: OTHER_SHA,
  });
  return dir;
}

function lines(): { io: { out(line: string): void }; out: string[] } {
  const out: string[] = [];
  return { io: { out: (line) => out.push(line) }, out };
}

/** `git ls-remote`, answering `sha` for `refs/heads/main`; anything else is a miss. */
function lsRemote(sha: string | undefined): {
  calls: readonly ExecCall[];
  exec: DeployAppOptions["exec"];
} {
  const recording = createRecordingExec((call) =>
    sha === undefined ? { code: 0, stdout: "" } : { code: 0, stdout: `${sha}\trefs/heads/main\n` },
  );
  return { calls: recording.calls, exec: recording.exec };
}

function options(
  dir: string,
  overrides: Partial<DeployAppOptions> = {},
): DeployAppOptions & { out: string[] } {
  const sink = lines();
  return {
    app: APP,
    io: sink.io,
    config: CONFIG,
    stateDir: dir,
    env: {},
    now: () => 0,
    sleep: async () => await Promise.resolve(),
    out: sink.out,
    ...overrides,
  };
}

/** The requests that reached Coolify, in order. */
function requests(): string[] {
  return harness.requests.map((request) => `${request.method} ${request.operationPath}`);
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe("hf deploy", () => {
  beforeAll(() => harness.server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => {
    harness.server.resetHandlers();
    const violations = harness.takeViolations();
    harness.reset();
    expect(violations).toEqual([]);
  });
  afterAll(() => harness.server.close());

  it("sets SOURCE_COMMIT to main's sha before deploying, and waits for the app to report it", async () => {
    const dir = await stateDirWith();
    harness.server.use(http.get(STATUS_URL, () => HttpResponse.json({ applicationVersion: MAIN_SHA })));
    const remote = lsRemote(MAIN_SHA);
    const run = options(dir, { exec: remote.exec });

    const result = await deployApp(run);

    expect(result).toEqual({ app: APP, sha: MAIN_SHA, url: `https://${APP}.${BASE_DOMAIN}` });
    expect(remote.calls[0]).toMatchObject({
      command: "git",
      args: ["ls-remote", `https://github.com/${REPO}.git`, "refs/heads/main"],
    });
    // Both entries written, both before the deploy: the build is what reads them.
    expect(requests()).toEqual([
      "GET /applications/{uuid}/envs",
      "PATCH /applications/{uuid}/envs",
      "PATCH /applications/{uuid}/envs",
      "POST /deploy",
      "GET /deployments/{uuid}",
    ]);
    expect(harness.requests[1]!.body).toEqual({
      key: "SOURCE_COMMIT",
      value: MAIN_SHA,
      is_buildtime: true,
      is_runtime: true,
      is_preview: false,
    });
    expect(harness.requests[2]!.body).toMatchObject({ is_preview: true });

    expect(run.out.at(-1)).toBe(`${APP}: serving 1111111 at https://${APP}.${BASE_DOMAIN}`);
    expect((await openAppState(APP, { dir })).state.lastDeployedSha).toBe(MAIN_SHA);
  });

  it("deploys --sha instead of main, and never asks the remote", async () => {
    const dir = await stateDirWith();
    harness.server.use(http.get(STATUS_URL, () => HttpResponse.json({ applicationVersion: OTHER_SHA })));
    const remote = lsRemote(MAIN_SHA);

    const result = await deployApp(options(dir, { sha: OTHER_SHA, exec: remote.exec }));

    expect(result.sha).toBe(OTHER_SHA);
    expect(remote.calls).toEqual([]);
    expect(harness.requests[1]!.body).toMatchObject({ value: OTHER_SHA });
  });

  it("refuses a --sha that is not a full commit, before one request", async () => {
    const dir = await stateDirWith();

    await expect(deployApp(options(dir, { sha: "1111111" }))).rejects.toThrow(
      /is not a commit sha/,
    );
    expect(harness.requests).toEqual([]);
  });

  it("says what it could not resolve when main names no commit", async () => {
    const dir = await stateDirWith();
    const remote = lsRemote(undefined);

    await expect(deployApp(options(dir, { exec: remote.exec }))).rejects.toThrow(
      /named no commit.*Pass --sha/s,
    );
    expect(harness.requests).toEqual([]);
  });

  it("says so when the state cache holds no repository to ask", async () => {
    const dir = await stateDirWith({ repo: undefined });

    await expect(deployApp(options(dir))).rejects.toThrow(/no owner\/name repository/);
  });

  it("names the state file when hf new never finished provisioning the app", async () => {
    const dir = await tempDir();
    await (await openAppState(APP, { dir })).patch({ repo: REPO });

    await expect(deployApp(options(dir))).rejects.toThrow(/no Coolify application uuid/);
  });

  it("needs a name through main", async () => {
    const err: string[] = [];
    const code = await main(["deploy"], { out: () => undefined, err: (line) => err.push(line) });

    expect(code).toBe(1);
    expect(err[0]).toContain("hf deploy needs a name");
  });
});
