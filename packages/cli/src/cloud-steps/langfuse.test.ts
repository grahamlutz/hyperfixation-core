import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runSteps } from "../new-cloud.js";
import { openAppState, type AppStateStore } from "../state.js";
import { createStepContext } from "../test-support/cloud-step.js";
import { createOpenApiHarness, type StubRoute } from "../test-support/openapi.js";
import { langfuseStep } from "./langfuse.js";

const APP = "demo-app";
const LANGFUSE = "https://langfuse.test";
const ORG_KEY = "pk-lf-org:sk-lf-org-sekrit";
const SECRET_KEY = "sk-lf-app-sekrit";

const CONFIG = { HF_LANGFUSE_URL: LANGFUSE, HF_LANGFUSE_ORG_KEY: ORG_KEY };

const PROJECTS_URL = `${LANGFUSE}/api/public/projects`;
const KEYS_URL = `${LANGFUSE}/api/public/projects/{projectId}/apiKeys`;

/** The adopting shape: the organization already holds this app's project. */
const ROUTES: StubRoute[] = [
  {
    spec: "langfuse",
    method: "get",
    url: PROJECTS_URL,
    json: { data: [{ id: "lp1", name: "demo_app" }] },
  },
  { spec: "langfuse", method: "post", url: PROJECTS_URL, json: { id: "lp2", name: "demo_app" } },
  {
    spec: "langfuse",
    method: "post",
    url: KEYS_URL,
    json: { id: "lk1", publicKey: "pk-lf-app", secretKey: SECRET_KEY },
  },
];

const harness = createOpenApiHarness(ROUTES);

describe("the cloud langfuse step", () => {
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
    workspace = await mkdtemp(path.join(tmpdir(), "hf-langfuse-step-"));
    state = await openAppState(APP, { dir: workspace });
  });

  const context = (): ReturnType<typeof createStepContext> =>
    createStepContext({ dir: path.join(workspace, APP), state, config: CONFIG });

  const paths = (): string[] =>
    harness.requests.map((request) => `${request.method} ${request.operationPath}`);

  it("issues no request when an earlier run recorded the step", async () => {
    await state.markDone("langfuse");

    await runSteps([langfuseStep], context());

    expect(harness.requests).toEqual([]);
  });

  it("reuses the project it finds by name and adds a key to it", async () => {
    const ctx = context();

    await runSteps([langfuseStep], ctx);

    expect(paths()).toEqual([
      "GET /api/public/projects",
      "POST /api/public/projects/{projectId}/apiKeys",
    ]);
    expect(harness.requests[1]!.pathname).toBe("/api/public/projects/lp1/apiKeys");
    expect(state.state.langfuse).toEqual({ publicKey: "pk-lf-app", secretKey: SECRET_KEY });
    expect(ctx.lines.join("\n")).toContain("adopting the Langfuse project");
    expect(ctx.lines.join("\n")).not.toContain(SECRET_KEY);
  });

  it("creates the project when the organization has none of that name", async () => {
    harness.server.use(
      harness.handler({ spec: "langfuse", method: "get", url: PROJECTS_URL, json: { data: [] } }),
    );

    await runSteps([langfuseStep], context());

    expect(paths()).toEqual([
      "GET /api/public/projects",
      "POST /api/public/projects",
      "POST /api/public/projects/{projectId}/apiKeys",
    ]);
    expect(harness.requests[1]!.body).toMatchObject({ name: "demo_app", retention: 0 });
    expect(harness.requests[2]!.pathname).toBe("/api/public/projects/lp2/apiKeys");
  });

  it("reuses the operator's project key pair without asking Langfuse anything", async () => {
    const ctx = createStepContext({
      dir: path.join(workspace, APP),
      state,
      config: {
        HF_LANGFUSE_URL: LANGFUSE,
        HF_LANGFUSE_PUBLIC_KEY: "pk-lf-existing",
        HF_LANGFUSE_SECRET_KEY: SECRET_KEY,
      },
    });

    await runSteps([langfuseStep], ctx);

    expect(harness.requests).toEqual([]);
    expect(state.isDone("langfuse")).toBe(true);
    expect(state.state.langfuse).toEqual({
      publicKey: "pk-lf-existing",
      secretKey: SECRET_KEY,
    });
    expect(ctx.lines.join("\n")).toContain("pk-lf-existing");
    expect(ctx.lines.join("\n")).toContain("traces into that one project");
    expect(ctx.lines.join("\n")).not.toContain(SECRET_KEY);
    expect(ctx.checklist).toEqual([]);
  });

  it("warns and leaves a checklist line when neither the org key nor a pair is set", async () => {
    const ctx = createStepContext({
      dir: path.join(workspace, APP),
      state,
      config: { HF_LANGFUSE_URL: LANGFUSE },
    });

    await runSteps([langfuseStep], ctx);

    expect(harness.requests).toEqual([]);
    expect(state.isDone("langfuse")).toBe(true);
    expect(state.state.langfuse).toBeUndefined();
    expect(ctx.lines.join("\n")).toContain("WARNING:");
    expect(ctx.checklist).toHaveLength(1);
    expect(ctx.checklist[0]).toContain("Langfuse tracing is not configured");
    expect(ctx.checklist[0]).toContain("LANGFUSE_SECRET_KEY");
  });

  it("records no key when the key create fails, and the rerun starts with the lookup", async () => {
    harness.server.use(
      harness.handler({
        spec: "langfuse",
        method: "post",
        url: KEYS_URL,
        status: 500,
        json: { message: "internal error" },
      }),
    );

    await expect(runSteps([langfuseStep], context())).rejects.toThrow(/HTTP 500/);
    expect(state.isDone("langfuse")).toBe(false);
    expect(state.state.langfuse).toBeUndefined();

    harness.server.resetHandlers();
    harness.reset();
    await runSteps([langfuseStep], context());

    expect(paths()[0]).toBe("GET /api/public/projects");
    expect(state.state.langfuse?.secretKey).toBe(SECRET_KEY);
  });
});
