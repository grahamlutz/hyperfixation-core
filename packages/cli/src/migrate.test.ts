import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { resolveApp } from "./app.js";
import { migrateApp, migrateChildEnv } from "./migrate.js";
import { MissingEnv } from "./require-env.js";
import { fakeApp } from "./test-support/fake-app.js";

const created: string[] = [];

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

const OVERLAY = {
  DATABASE_URL: "postgres://app@127.0.0.1:15432/hf_demo_app",
  MIGRATOR_DATABASE_URL: "postgres://migrator@127.0.0.1:15432/hf_demo_app",
};

describe("hf migrate's environment", () => {
  it("takes the connection URLs from the overlay when the app has no .env", async () => {
    const dir = await fakeApp({ appName: "demo_app" });
    created.push(dir);

    await expect(migrateApp({ dir, skipRoles: true })).rejects.toThrow(MissingEnv);

    // The overlay clears `requireEnv`; what fails next is the app's own `migrate.ts`, which a
    // fake app does not have — proof the run got past resolving its environment.
    await expect(migrateApp({ dir, skipRoles: true, env: OVERLAY })).rejects.not.toThrow(
      MissingEnv,
    );
  }, 30_000);

  it("hands the child the overlay and the shell's PATH, and none of the operator's tokens", async () => {
    const dir = await fakeApp({ appName: "demo_app" });
    created.push(dir);

    process.env.HF_COOLIFY_TOKEN = "cf-token-hunter2";
    try {
      const env = migrateChildEnv(await resolveApp(dir, { env: OVERLAY }));

      expect(env.DATABASE_URL).toBe(OVERLAY.DATABASE_URL);
      expect(env.HF_PROCESS).toBe("migrate");
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HF_COOLIFY_TOKEN).toBeUndefined();
    } finally {
      delete process.env.HF_COOLIFY_TOKEN;
    }
  });

  it("keeps the local path's environment: .env under the shell it was started from", async () => {
    const dir = await fakeApp({ appName: "demo_app", env: { DATABASE_URL: "postgres://dev" } });
    created.push(dir);

    process.env.HF_LOCAL_MARKER = "inherited";
    try {
      const env = migrateChildEnv(await resolveApp(dir));

      expect(env.DATABASE_URL).toBe("postgres://dev");
      expect(env.HF_LOCAL_MARKER).toBe("inherited");
    } finally {
      delete process.env.HF_LOCAL_MARKER;
    }
  });
});
