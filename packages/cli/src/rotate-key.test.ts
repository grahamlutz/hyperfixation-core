import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "./cli.js";
import type { OperatorConfig } from "./config.js";
import {
  NoKeyOnStdin,
  NotRotatable,
  readKeyFromStdin,
  rotateKey,
  ROTATABLE_ENV,
  type KeyInput,
  type RotateKeyOptions,
} from "./rotate-key.js";
import { openAppState } from "./state.js";
import { createOpenApiHarness, type StubRoute } from "./test-support/openapi.js";

const APP = "demo-app";
const COOLIFY = "https://coolify.test";
const APP_UUID = "application-1";

/**
 * The value under rotation, and the one string this whole file asserts the absence of.
 *
 * Distinctive on purpose: every line printed, every state file written and every request body but
 * the one PATCH is searched for it.
 */
const NEW_KEY = "sk-ant-rotated-sekrit-value";
const NOW = new Date("2026-09-26T09:00:00.000Z");

const CONFIG: OperatorConfig = {
  HF_COOLIFY_URL: COOLIFY,
  HF_COOLIFY_TOKEN: "coolify-token",
  HF_BASE_DOMAIN: "hf.test",
  HF_GITHUB_TOKEN: "github-token",
};

const ROUTES: StubRoute[] = [
  {
    spec: "coolify",
    method: "get",
    url: `${COOLIFY}/api/v1/applications/{uuid}/envs`,
    json: [
      { uuid: "env-1", key: "ANTHROPIC_API_KEY", value: "old-value", is_preview: false },
      { uuid: "env-2", key: "ANTHROPIC_API_KEY", value: "old-value", is_preview: true },
      { uuid: "env-3", key: "SMTP_URL", value: "smtp://old", is_preview: false },
    ],
  },
  { spec: "coolify", method: "patch", url: `${COOLIFY}/api/v1/applications/{uuid}/envs`, json: {} },
  {
    spec: "coolify",
    method: "post",
    url: `${COOLIFY}/api/v1/applications/{uuid}/envs`,
    json: { uuid: "env-4" },
  },
];

const harness = createOpenApiHarness(ROUTES);
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-rotate-"));
  tempDirs.push(dir);
  return dir;
}

/** The state file as a finished `hf new` leaves it. */
async function stateDirWith(options: { unprovisioned?: boolean } = {}): Promise<string> {
  const dir = await tempDir();
  const store = await openAppState(APP, { dir });
  await store.patch({
    repo: `grahamlutz/${APP}`,
    coolify: {
      projectUuid: "project-1",
      ...(options.unprovisioned === true ? {} : { appUuid: APP_UUID }),
    },
    statusTokens: { read: "read-token", write: "write-token" },
  });
  return dir;
}

function options(
  dir: string,
  overrides: Partial<RotateKeyOptions> = {},
): RotateKeyOptions & { out: string[] } {
  const out: string[] = [];
  return {
    app: APP,
    variable: "ANTHROPIC_API_KEY",
    value: NEW_KEY,
    io: { out: (line) => out.push(line) },
    config: CONFIG,
    stateDir: dir,
    env: {},
    now: () => NOW,
    deploy: async () => await Promise.resolve(),
    out,
    ...overrides,
  };
}

function requests(): string[] {
  return harness.requests.map((request) => `${request.method} ${request.operationPath}`);
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe("hf rotate-key", () => {
  beforeAll(() => harness.server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => {
    harness.server.resetHandlers();
    const violations = harness.takeViolations();
    harness.reset();
    expect(violations).toEqual([]);
  });
  afterAll(() => harness.server.close());

  it("replaces the one non-preview entry in a single PATCH, then deploys", async () => {
    const dir = await stateDirWith();
    const deployed: string[] = [];
    const run = options(dir, { deploy: async () => void deployed.push(APP) });

    const result = await rotateKey(run);

    expect(result).toEqual({
      app: APP,
      variable: "ANTHROPIC_API_KEY",
      rotatedAt: NOW.toISOString(),
      created: false,
    });
    expect(requests()).toEqual([
      "GET /applications/{uuid}/envs",
      "PATCH /applications/{uuid}/envs",
    ]);
    expect(harness.requests[1]!.body).toEqual({
      key: "ANTHROPIC_API_KEY",
      value: NEW_KEY,
      is_preview: false,
    });
    expect(deployed).toEqual([APP]);
  });

  it("creates the entry when Coolify has none under the name, and still deploys", async () => {
    const dir = await stateDirWith();
    const deployed: string[] = [];

    const result = await rotateKey(
      options(dir, { variable: "LOB_API_KEY", deploy: async () => void deployed.push(APP) }),
    );

    expect(result.created).toBe(true);
    expect(requests()).toEqual([
      "GET /applications/{uuid}/envs",
      "POST /applications/{uuid}/envs",
    ]);
    expect(deployed).toEqual([APP]);
  });

  it("records the date in the state file and the value nowhere in it", async () => {
    const dir = await stateDirWith();

    await rotateKey(options(dir));

    const store = await openAppState(APP, { dir });
    expect(store.state.keys).toEqual({ ANTHROPIC_API_KEY: { rotatedAt: NOW.toISOString() } });
    expect(await readFile(path.join(dir, `${APP}.json`), "utf8")).not.toContain(NEW_KEY);
  });

  it("keeps an earlier variable's date when a second one is rotated", async () => {
    const dir = await stateDirWith();
    const earlier = new Date(NOW.getTime() - 86_400_000).toISOString();
    await (await openAppState(APP, { dir })).patch({ keys: { SMTP_URL: { rotatedAt: earlier } } });

    await rotateKey(options(dir));

    expect((await openAppState(APP, { dir })).state.keys).toEqual({
      SMTP_URL: { rotatedAt: earlier },
      ANTHROPIC_API_KEY: { rotatedAt: NOW.toISOString() },
    });
  });

  it("prints no line carrying the value", async () => {
    const dir = await stateDirWith();
    const run = options(dir);

    await rotateKey(run);

    expect(run.out.length).toBeGreaterThan(0);
    for (const line of run.out) expect(line).not.toContain(NEW_KEY);
    expect(run.out[0]).toContain("ANTHROPIC_API_KEY replaced in Coolify");
  });

  it("sends the value in that one request body and in no other", async () => {
    const dir = await stateDirWith();

    await rotateKey(options(dir));

    const carrying = harness.requests.filter((request) =>
      JSON.stringify(request.body ?? null).includes(NEW_KEY),
    );
    expect(carrying).toHaveLength(1);
    expect(carrying[0]!.method).toBe("PATCH");
  });

  it("keeps the value out of a Coolify refusal that quotes it back", async () => {
    const dir = await stateDirWith();
    harness.server.use(
      harness.handler({
        spec: "coolify",
        method: "patch",
        url: `${COOLIFY}/api/v1/applications/{uuid}/envs`,
        status: 422,
        json: { message: `The value ${NEW_KEY} is invalid.` },
      }),
    );

    const error = (await rotateKey(options(dir)).catch((cause: unknown) => cause)) as Error;

    expect(error.message).toContain("422");
    expect(error.message).not.toContain(NEW_KEY);
    // Nothing recorded: the key never reached Coolify, so nothing was rotated.
    expect((await openAppState(APP, { dir })).state.keys).toBeUndefined();
  });

  it("refuses a variable that is not one of the rotatable ones, before any request", async () => {
    const dir = await stateDirWith();

    await expect(rotateKey(options(dir, { variable: "DATABASE_URL" }))).rejects.toThrow(
      NotRotatable,
    );
    expect(harness.requests).toEqual([]);
  });

  it("names the state file when hf new never finished provisioning the app", async () => {
    const dir = await stateDirWith({ unprovisioned: true });

    await expect(rotateKey(options(dir))).rejects.toThrow(/no Coolify application uuid/);
    expect(harness.requests).toEqual([]);
  });

  describe("reading the value from stdin", () => {
    const input = (text: string, isTTY?: boolean): KeyInput =>
      Object.assign(Readable.from([text]), { isTTY });

    it("takes the one line, without its trailing newline", async () => {
      expect(await readKeyFromStdin(input(`${NEW_KEY}\n`))).toBe(NEW_KEY);
    });

    it("refuses a terminal, so no value is ever typed at an echoing prompt", async () => {
      await expect(readKeyFromStdin(input(NEW_KEY, true))).rejects.toThrow(NoKeyOnStdin);
    });

    it("refuses empty stdin and a value spanning two lines, quoting neither", async () => {
      await expect(readKeyFromStdin(input("\n"))).rejects.toThrow(/nothing arrived on it/);

      const error = (await readKeyFromStdin(input(`${NEW_KEY}\nmore\n`)).catch(
        (cause: unknown) => cause,
      )) as Error;
      expect(error.message).toContain("more than one line");
      expect(error.message).not.toContain(NEW_KEY);
    });
  });

  it("needs a name and a variable through main, and lists the ones it takes", async () => {
    const err: string[] = [];
    const code = await main(["rotate-key", APP], {
      out: () => undefined,
      err: (line) => err.push(line),
    });

    expect(code).toBe(1);
    expect(err[0]).toContain("hf rotate-key needs a name and a variable");
    expect(err[1]).toContain(ROTATABLE_ENV[0]);
  });
});
