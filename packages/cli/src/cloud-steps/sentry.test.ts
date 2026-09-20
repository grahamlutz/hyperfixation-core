import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runSteps } from "../new-cloud.js";
import { openAppState, type AppStateStore } from "../state.js";
import { createStepContext } from "../test-support/cloud-step.js";
import { createOpenApiHarness, type StubRoute } from "../test-support/openapi.js";
import { sentryStep } from "./sentry.js";

const APP = "demo-app";
const ORG = "hf";
const SENTRY = "https://sentry.io";
const TOKEN = "sentry-token-sekrit";
const DSN = "https://dsn-key-sekrit@o1.ingest.sentry.io/1";

const CONFIG = { HF_SENTRY_TOKEN: TOKEN, HF_SENTRY_ORG: ORG };

const KEYS_URL = `${SENTRY}/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/keys/`;
const PROJECTS_URL = `${SENTRY}/api/0/organizations/{organization_id_or_slug}/projects/`;

const KEYS: StubRoute = {
  spec: "sentry",
  method: "get",
  url: KEYS_URL,
  json: [{ id: "k1", name: "Default", dsn: { public: DSN } }],
};

/** The adopting shape: the project is there, and the keys request is both lookup and answer. */
const ROUTES: StubRoute[] = [
  KEYS,
  {
    spec: "sentry",
    method: "post",
    url: PROJECTS_URL,
    status: 201,
    json: { id: "1", slug: "demo_app", name: "demo_app" },
  },
];

const harness = createOpenApiHarness(ROUTES);

describe("the cloud sentry step", () => {
  let workspace: string;
  let state: AppStateStore;

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
    workspace = await mkdtemp(path.join(tmpdir(), "hf-sentry-step-"));
    state = await openAppState(APP, { dir: workspace });
  });

  const context = (): ReturnType<typeof createStepContext> =>
    createStepContext({ dir: path.join(workspace, APP), state, config: CONFIG });

  const paths = (): string[] =>
    harness.requests.map((request) => `${request.method} ${request.operationPath}`);

  it("issues no request when an earlier run recorded the step", async () => {
    await state.markDone("sentry");

    await runSteps([sentryStep], context());

    expect(harness.requests).toEqual([]);
  });

  it("reuses the DSN of a project that already exists, creating nothing", async () => {
    const ctx = context();

    await runSteps([sentryStep], ctx);

    expect(paths()).toEqual([
      "GET /api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/keys/",
    ]);
    expect(state.state.sentryDsn).toBe(DSN);
    expect(ctx.lines.join("\n")).toContain("adopting the Sentry project hf/demo_app");
    // The DSN is a credential: it reaches the app through Coolify, never a terminal.
    expect(ctx.lines.join("\n")).not.toContain("dsn-key-sekrit");
  });

  it("creates the project when there is none, then reads its DSN", async () => {
    harness.server.use(
      harness.handler({ spec: "sentry", method: "get", url: KEYS_URL, status: 404, json: {}, once: true }),
    );

    await runSteps([sentryStep], context());

    expect(paths()).toEqual([
      "GET /api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/keys/",
      "POST /api/0/organizations/{organization_id_or_slug}/projects/",
      "GET /api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/keys/",
    ]);
    expect(harness.requests[1]!.body).toMatchObject({
      name: "demo_app",
      slug: "demo_app",
      platform: "node",
    });
    expect(state.state.sentryDsn).toBe(DSN);
  });

  it("records no DSN when the create fails, and the rerun starts with the lookup", async () => {
    harness.server.use(
      harness.handler({ spec: "sentry", method: "get", url: KEYS_URL, status: 404, json: {}, once: true }),
      harness.handler({
        spec: "sentry",
        method: "post",
        url: PROJECTS_URL,
        status: 500,
        json: { detail: "internal error" },
      }),
    );

    await expect(runSteps([sentryStep], context())).rejects.toThrow(/HTTP 500/);
    expect(state.isDone("sentry")).toBe(false);
    expect(state.state.sentryDsn).toBeUndefined();

    harness.server.resetHandlers();
    harness.reset();
    await runSteps([sentryStep], context());

    expect(paths()[0]).toBe(
      "GET /api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/keys/",
    );
    expect(state.state.sentryDsn).toBe(DSN);
  });
});
