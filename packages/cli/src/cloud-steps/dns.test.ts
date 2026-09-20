import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runSteps } from "../new-cloud.js";
import { openAppState, type AppStateStore } from "../state.js";
import { createStepContext } from "../test-support/cloud-step.js";
import { createOpenApiHarness, type StubRoute } from "../test-support/openapi.js";
import { StepFailed } from "./context.js";
import { dnsStep } from "./dns.js";

const APP = "demo-app";
const CLOUDFLARE = "https://api.cloudflare.com/client/v4";
const ZONE = "zone-id";
const BOX_IP = "203.0.113.7";
const OTHER_IP = "198.51.100.4";
const FQDN = `${APP}.hf.test`;

const CONFIG = {
  HF_CLOUDFLARE_TOKEN: "cloudflare-token-sekrit",
  HF_CLOUDFLARE_ZONE_ID: ZONE,
  HF_BASE_DOMAIN: "hf.test",
  HF_BOX_IP: BOX_IP,
};

const LIST_URL = `${CLOUDFLARE}/zones/{zone_id}/dns_records`;

function record(content: string): unknown {
  return { id: "r1", type: "A", name: FQDN, content, proxied: false, ttl: 1 };
}

/** The cold-run shape: the zone has no such record yet. */
const ROUTES: StubRoute[] = [
  {
    spec: "cloudflare",
    method: "get",
    url: LIST_URL,
    json: { success: true, errors: [], result: [] },
  },
  {
    spec: "cloudflare",
    method: "post",
    url: LIST_URL,
    status: 201,
    json: { success: true, errors: [], result: record(BOX_IP) },
  },
];

const harness = createOpenApiHarness(ROUTES);

describe("the cloud dns step", () => {
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
    workspace = await mkdtemp(path.join(tmpdir(), "hf-dns-step-"));
    state = await openAppState(APP, { dir: workspace });
  });

  const context = (): ReturnType<typeof createStepContext> =>
    createStepContext({ dir: path.join(workspace, APP), state, config: CONFIG });

  const methods = (): string[] => harness.requests.map((request) => request.method);

  const listing = (content: string): StubRoute => ({
    spec: "cloudflare",
    method: "get",
    url: LIST_URL,
    json: { success: true, errors: [], result: [record(content)] },
  });

  it("issues no request when an earlier run recorded the step", async () => {
    await state.markDone("dns");

    await runSteps([dnsStep], context());

    expect(harness.requests).toEqual([]);
  });

  it("creates the DNS-only A record when the zone has none", async () => {
    await runSteps([dnsStep], context());

    expect(methods()).toEqual(["GET", "POST"]);
    expect(harness.requests[0]!.query).toEqual({ name: FQDN, type: "A" });
    expect(harness.requests[1]!.body).toMatchObject({
      type: "A",
      name: FQDN,
      content: BOX_IP,
      ttl: 1,
      proxied: false,
      comment: `hf new ${APP}`,
    });
  });

  it("creates nothing when the record already points at the box", async () => {
    harness.server.use(harness.handler(listing(BOX_IP)));
    const ctx = context();

    await runSteps([dnsStep], ctx);

    expect(methods()).toEqual(["GET"]);
    expect(ctx.lines.join("\n")).toContain(`${FQDN} already points at ${BOX_IP}`);
  });

  it("refuses a record pointing somewhere else, rather than adding a second one", async () => {
    harness.server.use(harness.handler(listing(OTHER_IP)));

    const failure = await runSteps([dnsStep], context()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StepFailed);
    expect((failure as Error).message).toContain(OTHER_IP);
    expect((failure as Error).message).toContain(BOX_IP);
    expect((failure as Error).message).toContain("nor adds a second one");
    expect(methods()).toEqual(["GET"]);
    expect(state.isDone("dns")).toBe(false);
  });

  it("refuses the 200 that Cloudflare answers with success false", async () => {
    harness.server.use(
      harness.handler({
        spec: "cloudflare",
        method: "get",
        url: LIST_URL,
        json: { success: false, errors: [{ code: 9109, message: "Invalid access token" }], result: [] },
      }),
    );

    const failure = await runSteps([dnsStep], context()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StepFailed);
    expect((failure as Error).message).toContain("Invalid access token");
    expect((failure as Error).message).not.toContain("cloudflare-token-sekrit");
    expect(state.isDone("dns")).toBe(false);
  });
});
