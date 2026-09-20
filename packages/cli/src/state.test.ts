import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InsecureFileMode } from "./secret-file.js";
import {
  AppStateInvalid,
  generateBetterAuthSecret,
  openAppState,
  secretsHash,
  STEPS,
  stateFile,
} from "./state.js";

const APPLICATION_PASSWORD = "app-role-hunter2";

describe("per-app state cache", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hf-state-"));
    file = path.join(dir, "demo-app.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lives at ~/.config/hf/state/<name>.json", () => {
    expect(stateFile("demo-app", { XDG_CONFIG_HOME: "/x" })).toBe("/x/hf/state/demo-app.json");
  });

  it("starts empty, and writes at 0600 under a 0700 directory", async () => {
    const state = await openAppState("demo-app", { dir: path.join(dir, "state") });
    expect(state.state).toEqual({ steps: {} });

    await state.markDone("template");

    expect((await stat(state.file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(dir, "state"))).mode & 0o777).toBe(0o700);
  });

  it("marks a step done and reads it back from the file", async () => {
    const first = await openAppState("demo-app", { dir });
    expect(first.isDone("repo")).toBe(false);

    await first.markDone("repo");

    expect(first.isDone("repo")).toBe(true);
    const reopened = await openAppState("demo-app", { dir });
    expect(reopened.isDone("repo")).toBe(true);
    expect(reopened.state.steps.repo!.doneAt).toBe(first.state.steps.repo!.doneAt);
  });

  it("merges nested records field by field, so a later step keeps the earlier one's uuid", async () => {
    const state = await openAppState("demo-app", { dir });

    await state.patch({ coolify: { projectUuid: "p1" } });
    await state.patch({ coolify: { appUuid: "a1" } });
    await state.patch({ database: { applicationPassword: APPLICATION_PASSWORD } });
    await state.patch({ repo: "grahamlutz/demo-app", lastDeployedSha: "abc1234" });

    expect(state.state).toEqual({
      steps: {},
      coolify: { projectUuid: "p1", appUuid: "a1" },
      database: { applicationPassword: APPLICATION_PASSWORD },
      repo: "grahamlutz/demo-app",
      lastDeployedSha: "abc1234",
    });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(state.state);
  });

  it("leaves no temp file behind, so a later run is not confused by one", async () => {
    const state = await openAppState("demo-app", { dir });
    await state.markDone("dns");

    expect(await readdir(dir)).toEqual(["demo-app.json"]);
  });

  it("tightens a 0644 state file and refuses the run", async () => {
    await writeFile(
      file,
      JSON.stringify({ steps: {}, database: { applicationPassword: APPLICATION_PASSWORD } }),
      { mode: 0o644 },
    );
    await chmod(file, 0o644);

    const refusal = await openAppState("demo-app", { dir }).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(InsecureFileMode);
    expect((refusal as Error).message).not.toContain(APPLICATION_PASSWORD);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("refuses a truncated file and leaves every byte of it alone", async () => {
    const truncated = `{"steps":{},"database":{"applicationPassword":"${APPLICATION_PASSWORD}`;
    await writeFile(file, truncated, { mode: 0o600 });
    await chmod(file, 0o600);

    const refusal = await openAppState("demo-app", { dir }).catch((e: unknown) => e);

    expect(refusal).toBeInstanceOf(AppStateInvalid);
    expect((refusal as Error).message).not.toContain(APPLICATION_PASSWORD);
    expect(await readFile(file, "utf8")).toBe(truncated);
  });

  it("refuses a file whose shape it does not recognise, again without rewriting it", async () => {
    const cases: [string, unknown][] = [
      ["no steps", { repo: "grahamlutz/demo-app" }],
      ["an unknown key", { steps: {}, sentryDSN: "https://k@o/1" }],
      ["an unknown step", { steps: { publish: { doneAt: "2026-09-19T00:00:00.000Z" } } }],
      ["a step without doneAt", { steps: { repo: {} } }],
      ["a nested key that is not a string", { steps: {}, coolify: { projectUuid: 7 } }],
      ["a nested key it does not know", { steps: {}, langfuse: { orgKey: "pk:sk" } }],
    ];

    for (const [what, contents] of cases) {
      const text = JSON.stringify(contents);
      await writeFile(file, text, { mode: 0o600 });
      await chmod(file, 0o600);

      const refusal = await openAppState("demo-app", { dir }).catch((e: unknown) => e);

      expect(refusal, what).toBeInstanceOf(AppStateInvalid);
      expect(await readFile(file, "utf8")).toBe(text);
    }
  });

  it("runs the rotating database step immediately before coolify", () => {
    // Every fallible external create comes first, so a failure in one of them can never leave a
    // deployed app holding passwords the run has already replaced.
    expect([...STEPS]).toEqual([
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
  });

  it("forgets a step on demand, which is how a rotation forces the coolify PATCH again", async () => {
    const state = await openAppState("demo-app", { dir });
    await state.markDone("coolify");

    await state.clearDone("coolify");

    expect(state.isDone("coolify")).toBe(false);
    expect((await openAppState("demo-app", { dir })).isDone("coolify")).toBe(false);
  });

  it("generates a better-auth secret that is 32 bytes and never the same twice", () => {
    const secret = generateBetterAuthSecret();

    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    expect(generateBetterAuthSecret()).not.toBe(secret);
  });

  it("hashes exactly the secrets the Coolify envs carry, and nothing around them", async () => {
    const state = await openAppState("demo-app", { dir });
    await state.patch({
      database: { migratorPassword: "m", applicationPassword: "a" },
      betterAuthSecret: "s",
      statusTokens: { read: "rt", write: "wt" },
    });
    const before = secretsHash(state.state);

    await state.patch({ repo: "grahamlutz/demo-app", lastDeployedSha: "abc1234" });
    expect(secretsHash(state.state)).toBe(before);

    await state.patch({ database: { applicationPassword: "a2" } });
    expect(secretsHash(state.state)).not.toBe(before);
  });

  it("round-trips every field a cloud hf new writes", async () => {
    const state = await openAppState("demo-app", { dir });

    for (const step of STEPS) await state.markDone(step);
    await state.patch({
      repo: "grahamlutz/demo-app",
      coolify: { projectUuid: "p1", appUuid: "a1", envsSecretsHash: "f".repeat(64) },
      database: {
        migratorPassword: "m",
        applicationPassword: APPLICATION_PASSWORD,
        readonlyPassword: "r",
      },
      sentryDsn: "https://k@o.ingest.sentry.io/1",
      betterAuthSecret: generateBetterAuthSecret(),
      langfuse: { publicKey: "pk-lf-1", secretKey: "sk-lf-1" },
      statusTokens: { read: "rt", write: "wt" },
      lastRestoreCheckAt: "2026-09-19T00:00:00.000Z",
      lastDeployedSha: "abc1234",
    });

    const reopened = await openAppState("demo-app", { dir });
    expect(reopened.state).toEqual(state.state);
    expect(STEPS.every((step) => reopened.isDone(step))).toBe(true);
  });
});
