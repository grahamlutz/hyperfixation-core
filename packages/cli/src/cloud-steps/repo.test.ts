import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runSteps } from "../new-cloud.js";
import { openAppState, type AppStateStore } from "../state.js";
import {
  createRecordingExec,
  createStepContext,
  isGit,
  type ExecCall,
  type RecordingExec,
} from "../test-support/cloud-step.js";
import { createOpenApiHarness, type StubRoute } from "../test-support/openapi.js";
import { StepFailed } from "./context.js";
import { repoStep } from "./repo.js";

const APP = "demo-app";
const OWNER = "grahamlutz";
const FULL_NAME = `${OWNER}/${APP}`;
const GITHUB = "https://api.github.com";
const HEAD = "1".repeat(40);
const OTHER_SHA = "2".repeat(40);
const TOKEN = "github-token-sekrit";

const CONFIG = {
  HF_GITHUB_TOKEN: TOKEN,
  HF_GITHUB_OWNER: OWNER,
  HF_GITHUB_APP_SLUGS: "coolify, hyperfixation-bump",
};

const INSTALLATIONS = {
  total_count: 2,
  installations: [
    { id: 1, app_id: 10, app_slug: "coolify" },
    { id: 2, app_id: 11, app_slug: "hyperfixation-bump" },
  ],
};

/** The cold-run shape: no such repository yet, both apps installed on the account. */
const ROUTES: StubRoute[] = [
  { spec: "github", method: "get", url: `${GITHUB}/repos/{owner}/{repo}`, status: 404, json: {} },
  {
    spec: "github",
    method: "get",
    url: `${GITHUB}/users/{username}`,
    json: { login: OWNER, type: "User" },
  },
  {
    spec: "github",
    method: "post",
    url: `${GITHUB}/user/repos`,
    status: 201,
    json: { full_name: FULL_NAME, private: true, default_branch: "main" },
  },
  {
    spec: "github",
    method: "post",
    url: `${GITHUB}/orgs/{org}/repos`,
    status: 201,
    json: { full_name: FULL_NAME, private: true, default_branch: "main" },
  },
  {
    spec: "github",
    method: "get",
    url: `${GITHUB}/repos/{owner}/{repo}/git/ref/heads/main`,
    json: { ref: "refs/heads/main", object: { sha: HEAD, type: "commit" } },
  },
  { spec: "github", method: "get", url: `${GITHUB}/user/installations`, json: INSTALLATIONS },
  {
    spec: "github",
    method: "get",
    url: `${GITHUB}/user/installations/{installation_id}/repositories`,
    json: { total_count: 1, repository_selection: "selected", repositories: [{ full_name: FULL_NAME }] },
  },
];

const harness = createOpenApiHarness(ROUTES);

/** The repository is there; `sha` is what its `main` points at, or 409 for an empty one. */
function repositoryExists(sha: string | undefined): StubRoute[] {
  return [
    {
      spec: "github",
      method: "get",
      url: `${GITHUB}/repos/{owner}/{repo}`,
      json: { full_name: FULL_NAME, private: true, default_branch: "main" },
    },
    sha === undefined
      ? {
          spec: "github",
          method: "get",
          url: `${GITHUB}/repos/{owner}/{repo}/git/ref/heads/main`,
          status: 409,
          json: { message: "Git Repository is empty." },
        }
      : {
          spec: "github",
          method: "get",
          url: `${GITHUB}/repos/{owner}/{repo}/git/ref/heads/main`,
          json: { ref: "refs/heads/main", object: { sha, type: "commit" } },
        },
  ];
}

describe("the cloud repo step", () => {
  let workspace: string;
  let dir: string;
  let state: AppStateStore;
  let exec: RecordingExec;

  beforeAll(() => harness.server.listen({ onUnhandledRequest: "error" }));
  afterEach(async () => {
    harness.server.resetHandlers();
    const violations = harness.takeViolations();
    harness.reset();
    await rm(workspace, { recursive: true, force: true });
    expect(violations).toEqual([]);
  });
  afterAll(() => harness.server.close());

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "hf-repo-step-"));
    const stateDir = path.join(workspace, "state");
    await mkdir(stateDir);
    state = await openAppState(APP, { dir: stateDir });
    dir = path.join(workspace, APP);
    await mkdir(dir);

    exec = createRecordingExec((call: ExecCall) => {
      if (isGit(call, "rev-parse")) return { stdout: `${HEAD}\n` };
      // No `origin` yet, which is what a first run finds.
      if (isGit(call, "remote") && call.args[1] === "get-url") return { code: 2 };
      return undefined;
    });
  });

  const context = (): ReturnType<typeof createStepContext> =>
    createStepContext({ dir, state, config: CONFIG, exec: exec.exec });

  const paths = (): string[] =>
    harness.requests.map((request) => `${request.method} ${request.operationPath}`);

  const ran = (): string[] => exec.calls.map((call) => [call.command, ...call.args].join(" "));

  it("issues no request and runs no command when an earlier run recorded the step", async () => {
    await state.markDone("repo");

    await runSteps([repoStep], context());

    expect(harness.requests).toEqual([]);
    expect(exec.calls).toEqual([]);
  });

  it("creates the private repository, pushes, and asserts both apps see it", async () => {
    await runSteps([repoStep], context());

    expect(paths()).toEqual([
      "GET /repos/{owner}/{repo}",
      "GET /users/{username}",
      "POST /user/repos",
      "GET /user/installations",
      "GET /user/installations/{installation_id}/repositories",
      "GET /user/installations/{installation_id}/repositories",
    ]);
    // `toMatchObject`: the validator fills the document's defaults into the body it checked.
    expect(harness.requests[2]!.body).toMatchObject({ name: APP, private: true });
    expect(ran()).toEqual([
      "git rev-parse HEAD",
      "git remote get-url origin",
      `git remote add origin https://github.com/${FULL_NAME}.git`,
      "git push --set-upstream origin main",
    ]);
    expect(state.state.repo).toBe(FULL_NAME);
  });

  it("hands git the token in the child's environment and nowhere else", async () => {
    await runSteps([repoStep], context());

    const push = exec.calls.find((call) => isGit(call, "push"))!;
    const header = Buffer.from(`x-access-token:${TOKEN}`, "utf8").toString("base64");
    expect(push.options.env).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${header}`,
    });
    // Never in argv, where `ps` reads it, and never in the remote URL git writes to `.git/config`.
    expect(JSON.stringify(exec.calls.map((call) => call.args))).not.toContain(TOKEN);
    const others = exec.calls.filter((call) => call !== push);
    expect(others.every((call) => call.options.env === undefined)).toBe(true);
  });

  it("creates under an organization when the owner is one", async () => {
    harness.server.use(
      harness.handler({
        spec: "github",
        method: "get",
        url: `${GITHUB}/users/{username}`,
        json: { login: OWNER, type: "Organization" },
      }),
    );

    await runSteps([repoStep], context());

    expect(paths()).toContain("POST /orgs/{org}/repos");
    expect(paths()).not.toContain("POST /user/repos");
  });

  it("adopts a repository whose main is this app's commit, and pushes nothing", async () => {
    harness.server.use(...repositoryExists(HEAD).map(harness.handler));
    const ctx = context();

    await runSteps([repoStep], ctx);

    expect(paths().every((entry) => entry.startsWith("GET "))).toBe(true);
    expect(ran()).not.toContain("git push --set-upstream origin main");
    expect(ctx.lines.join("\n")).toContain(`adopting ${FULL_NAME}`);
    expect(state.state.repo).toBe(FULL_NAME);
  });

  it("refuses an unrelated repository of the same name", async () => {
    harness.server.use(...repositoryExists(OTHER_SHA).map(harness.handler));

    const failure = await runSteps([repoStep], context()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StepFailed);
    expect((failure as Error).message).toContain(FULL_NAME);
    expect((failure as Error).message).toContain("will not push over");
    expect((failure as Error).message).not.toContain(TOKEN);
    expect(ran()).not.toContain("git push --set-upstream origin main");
    expect(state.isDone("repo")).toBe(false);
    expect(state.state.repo).toBeUndefined();
  });

  it("pushes into an existing empty repository", async () => {
    harness.server.use(...repositoryExists(undefined).map(harness.handler));

    await runSteps([repoStep], context());

    expect(ran()).toContain("git push --set-upstream origin main");
    expect(paths()).not.toContain("POST /user/repos");
  });

  it("names the GitHub App that is not installed, and how to install it", async () => {
    harness.server.use(
      harness.handler({
        spec: "github",
        method: "get",
        url: `${GITHUB}/user/installations`,
        json: { total_count: 1, installations: [INSTALLATIONS.installations[0]] },
      }),
    );

    const failure = await runSteps([repoStep], context()).catch((error: unknown) => error);

    expect((failure as Error).message).toContain("hyperfixation-bump");
    expect((failure as Error).message).toContain("https://github.com/apps/hyperfixation-bump");
    expect(state.isDone("repo")).toBe(false);
  });

  /** GitHub's answer to a token that is not a GitHub App user-to-server token. */
  const listingRefused = (status: number): StubRoute => ({
    spec: "github",
    method: "get",
    url: `${GITHUB}/user/installations`,
    status,
    json: {
      message:
        "You must authenticate with an access token authorized to a GitHub App in order to " +
        "list installations",
    },
  });

  it.each([403, 401, 404])(
    "finishes the step with a warning when the token may not list installations (%i)",
    async (status) => {
      harness.server.use(harness.handler(listingRefused(status)));
      const ctx = context();

      await runSteps([repoStep], ctx);

      const warning = ctx.lines.find((line) => line.startsWith("WARNING:"))!;
      expect(warning).toContain("could not be verified with this token");
      expect(warning).toContain(`HTTP ${String(status)}`);
      for (const slug of ["coolify", "hyperfixation-bump"]) {
        expect(warning).toContain(`${slug} (https://github.com/apps/${slug}/installations/new)`);
      }
      // The same sentence again in the run's closing checklist, which is `fromSteps` there.
      expect(ctx.checklist).toEqual([warning.slice(`WARNING: ${APP}: `.length)]);
      expect(paths()).not.toContain("GET /user/installations/{installation_id}/repositories");
      expect(ran()).toContain("git push --set-upstream origin main");
      expect(state.isDone("repo")).toBe(true);
      expect(state.state.repo).toBe(FULL_NAME);
    },
  );

  it("still fails when listing the installations breaks for another reason", async () => {
    harness.server.use(harness.handler(listingRefused(500)));
    const ctx = context();

    await expect(runSteps([repoStep], ctx)).rejects.toThrow(/HTTP 500/);
    expect(ctx.checklist).toEqual([]);
    expect(state.isDone("repo")).toBe(false);
    expect(state.state.repo).toBeUndefined();
  });

  it("records nothing when the create fails, and the rerun starts with the lookup", async () => {
    harness.server.use(
      harness.handler({
        spec: "github",
        method: "post",
        url: `${GITHUB}/user/repos`,
        status: 500,
        json: { message: "internal error" },
      }),
    );

    await expect(runSteps([repoStep], context())).rejects.toThrow(/HTTP 500/);
    expect(state.isDone("repo")).toBe(false);
    expect(state.state.repo).toBeUndefined();

    harness.server.resetHandlers();
    harness.reset();
    await runSteps([repoStep], context());

    expect(paths()[0]).toBe("GET /repos/{owner}/{repo}");
    expect(state.state.repo).toBe(FULL_NAME);
  });
});
