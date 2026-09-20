import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runSteps } from "../new-cloud.js";
import { openAppState, type AppStateStore } from "../state.js";
import { createStepContext } from "../test-support/cloud-step.js";
import { createOpenApiHarness, type StubRoute } from "../test-support/openapi.js";
import { backupStep } from "./backup.js";

const APP = "demo-app";
const COOLIFY = "https://coolify.test";
const POSTGRES_UUID = "pg-uuid";
const TOKEN = "coolify-token-sekrit";

const CONFIG = {
  HF_COOLIFY_URL: COOLIFY,
  HF_COOLIFY_TOKEN: TOKEN,
  HF_COOLIFY_POSTGRES_UUID: POSTGRES_UUID,
};

const ROUTES: StubRoute[] = [
  {
    spec: "coolify",
    method: "post",
    url: `${COOLIFY}/api/v1/databases/{uuid}/backups`,
    json: { uuid: "b1" },
  },
];

const harness = createOpenApiHarness(ROUTES);

describe("the cloud backup step", () => {
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
    workspace = await mkdtemp(path.join(tmpdir(), "hf-backup-step-"));
    state = await openAppState(APP, { dir: workspace });
  });

  const context = (): ReturnType<typeof createStepContext> =>
    createStepContext({ dir: path.join(workspace, APP), state, config: CONFIG });

  it("issues no request when an earlier run recorded the step", async () => {
    await state.markDone("backup");

    await runSteps([backupStep], context());

    expect(harness.requests).toEqual([]);
  });

  it("registers a daily dump of this app's database alone, and says to check for a second", async () => {
    const ctx = context();

    await runSteps([backupStep], ctx);

    expect(harness.requests.map((request) => `${request.method} ${request.operationPath}`)).toEqual([
      "POST /databases/{uuid}/backups",
    ]);
    expect(harness.requests[0]!.pathname).toBe(`/api/v1/databases/${POSTGRES_UUID}/backups`);
    expect(harness.requests[0]!.body).toMatchObject({
      frequency: "daily",
      enabled: true,
      databases_to_backup: "hf_demo_app",
      dump_all: false,
      backup_now: false,
    });
    expect(ctx.checklist).toEqual([expect.stringContaining("hf_demo_app")]);
    expect(state.isDone("backup")).toBe(true);
  });

  it("records nothing when the registration fails, and says nothing to check", async () => {
    harness.server.use(
      harness.handler({
        spec: "coolify",
        method: "post",
        url: `${COOLIFY}/api/v1/databases/{uuid}/backups`,
        status: 500,
        json: { message: "internal error" },
      }),
    );
    const ctx = context();

    await expect(runSteps([backupStep], ctx)).rejects.toThrow(/HTTP 500/);

    expect(state.isDone("backup")).toBe(false);
    expect(ctx.checklist).toEqual([]);
  });
});
