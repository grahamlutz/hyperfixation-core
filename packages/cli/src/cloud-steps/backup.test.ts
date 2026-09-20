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

const STORAGE = {
  uuid: "s3-uuid",
  name: "hetzner-backups",
  bucket: "hf-backups",
  region: "fsn1",
  is_usable: true,
};

const ROUTES: StubRoute[] = [
  {
    spec: "coolify",
    method: "get",
    url: `${COOLIFY}/api/v1/s3-storages`,
    json: [STORAGE],
  },
  {
    spec: "coolify",
    method: "get",
    url: `${COOLIFY}/api/v1/databases/{uuid}/backups`,
    json: [],
  },
  {
    spec: "coolify",
    method: "post",
    url: `${COOLIFY}/api/v1/databases/{uuid}/backups`,
    json: { uuid: "b1" },
  },
  {
    spec: "coolify",
    method: "patch",
    url: `${COOLIFY}/api/v1/databases/{uuid}/backups/{scheduled_backup_uuid}`,
    json: { message: "updated" },
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

  const context = (config: Record<string, string> = CONFIG): ReturnType<typeof createStepContext> =>
    createStepContext({ dir: path.join(workspace, APP), state, config });

  /** Replaces the default `GET /s3-storages` answer for one test. */
  const storages = (json: unknown): void => {
    harness.server.use(
      harness.handler({ spec: "coolify", method: "get", url: `${COOLIFY}/api/v1/s3-storages`, json }),
    );
  };

  it("issues no request when an earlier run recorded the step", async () => {
    await state.markDone("backup");

    await runSteps([backupStep], context());

    expect(harness.requests).toEqual([]);
  });

  it("registers a daily dump of this app's database alone, to the one usable S3 storage", async () => {
    const ctx = context();

    await runSteps([backupStep], ctx);

    expect(harness.requests.map((request) => `${request.method} ${request.operationPath}`)).toEqual([
      "GET /s3-storages",
      "GET /databases/{uuid}/backups",
      "POST /databases/{uuid}/backups",
    ]);
    const created = harness.requests[2]!;
    expect(created.pathname).toBe(`/api/v1/databases/${POSTGRES_UUID}/backups`);
    expect(created.body).toMatchObject({
      frequency: "daily",
      enabled: true,
      databases_to_backup: "hf_demo_app",
      dump_all: false,
      backup_now: false,
      save_s3: true,
      s3_storage_uuid: STORAGE.uuid,
    });
    expect(ctx.checklist).toEqual([]);
    expect(state.isDone("backup")).toBe(true);
  });

  it("takes HF_COOLIFY_S3_STORAGE_UUID without listing the storages", async () => {
    const ctx = context({ ...CONFIG, HF_COOLIFY_S3_STORAGE_UUID: "operator-choice" });

    await runSteps([backupStep], ctx);

    expect(harness.requests.map((request) => `${request.method} ${request.operationPath}`)).toEqual([
      "GET /databases/{uuid}/backups",
      "POST /databases/{uuid}/backups",
    ]);
    expect(harness.requests[1]!.body).toMatchObject({
      save_s3: true,
      s3_storage_uuid: "operator-choice",
    });
    expect(ctx.checklist).toEqual([]);
  });

  it("registers a local-only schedule and warns when the box has no usable storage", async () => {
    storages([{ uuid: "unusable", name: "broken", is_usable: false }]);
    const ctx = context();

    await runSteps([backupStep], ctx);

    expect(harness.requests[2]!.body).toMatchObject({ save_s3: false });
    expect(harness.requests[2]!.body).not.toHaveProperty("s3_storage_uuid");
    expect(ctx.lines).toContainEqual(
      expect.stringContaining("WARNING: demo-app: hf_demo_app's daily backup is local-only"),
    );
    expect(ctx.checklist).toEqual([
      expect.stringContaining("HF_COOLIFY_S3_STORAGE_UUID"),
    ]);
    expect(ctx.checklist[0]).toContain("no usable S3 storage");
    expect(state.isDone("backup")).toBe(true);
  });

  it("names the candidates rather than guessing when several storages are usable", async () => {
    storages([STORAGE, { uuid: "s3-two", name: "offsite", is_usable: true }]);
    const ctx = context();

    await runSteps([backupStep], ctx);

    expect(harness.requests[2]!.body).toMatchObject({ save_s3: false });
    expect(ctx.checklist[0]).toContain("hetzner-backups (s3-uuid), offsite (s3-two)");
  });

  it("patches the schedule an earlier run registered rather than adding a second", async () => {
    harness.server.use(
      harness.handler({
        spec: "coolify",
        method: "get",
        url: `${COOLIFY}/api/v1/databases/{uuid}/backups`,
        json: [
          { uuid: "other", databases_to_backup: "hf_something_else" },
          { uuid: "mine", databases_to_backup: "hf_demo_app" },
        ],
      }),
    );
    const ctx = context();

    await runSteps([backupStep], ctx);

    expect(harness.requests.map((request) => `${request.method} ${request.operationPath}`)).toEqual([
      "GET /s3-storages",
      "GET /databases/{uuid}/backups",
      "PATCH /databases/{uuid}/backups/{scheduled_backup_uuid}",
    ]);
    expect(harness.requests[2]!.pathname).toBe(
      `/api/v1/databases/${POSTGRES_UUID}/backups/mine`,
    );
    expect(harness.requests[2]!.body).toMatchObject({
      save_s3: true,
      s3_storage_uuid: STORAGE.uuid,
      databases_to_backup: "hf_demo_app",
    });
    expect(ctx.checklist).toEqual([]);
  });

  it("registers and says to check for a second when the backups list cannot be read", async () => {
    harness.server.use(
      harness.handler({
        spec: "coolify",
        method: "get",
        url: `${COOLIFY}/api/v1/databases/{uuid}/backups`,
        json: "Content is very complex. Will be implemented later.",
      }),
    );
    const ctx = context();

    await runSteps([backupStep], ctx);

    expect(harness.requests.map((request) => `${request.method} ${request.operationPath}`)).toEqual([
      "GET /s3-storages",
      "GET /databases/{uuid}/backups",
      "POST /databases/{uuid}/backups",
    ]);
    expect(ctx.checklist).toEqual([expect.stringContaining("a second backup schedule")]);
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
