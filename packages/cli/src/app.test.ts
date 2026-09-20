import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotAnApp, resolveApp } from "./app.js";
import { fakeApp } from "./test-support/fake-app.js";

const created: string[] = [];

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("resolveApp", () => {
  it("takes the app name from package.json and derives every identifier from it", async () => {
    const dir = await fakeApp({ appName: "demo_app" });
    created.push(dir);

    const app = await resolveApp(dir);

    expect(app.appName).toBe("demo_app");
    expect(app.names.databaseName).toBe("hf_demo_app");
    expect(app.migrationsDir).toBe(path.join(app.dir, "drizzle"));
  });

  it("finds the app from a directory inside it", async () => {
    const dir = await fakeApp({ appName: "demo_app" });
    created.push(dir);
    const nested = path.join(dir, "src", "flows");
    await mkdir(nested, { recursive: true });

    expect((await resolveApp(nested)).dir).toBe((await resolveApp(dir)).dir);
  });

  it("reads .env, and lets the process environment win over it", async () => {
    const dir = await fakeApp({ appName: "demo_app", env: { APP_URL: "http://from-file" } });
    created.push(dir);

    process.env.APP_URL = "http://from-shell";
    try {
      const app = await resolveApp(dir);
      expect(app.envFile.APP_URL).toBe("http://from-file");
      expect(app.env.APP_URL).toBe("http://from-shell");
    } finally {
      delete process.env.APP_URL;
    }
  });

  it("lets an env overlay win over both the file and the shell, for the cloud path's tunnel", async () => {
    const dir = await fakeApp({
      appName: "demo_app",
      env: { DATABASE_URL: "postgres://localhost/dev" },
    });
    created.push(dir);

    process.env.DATABASE_URL = "postgres://localhost/some-other-dev-app";
    try {
      const app = await resolveApp(dir, { env: { DATABASE_URL: "postgres://127.0.0.1:15432/hf" } });

      expect(app.env.DATABASE_URL).toBe("postgres://127.0.0.1:15432/hf");
      expect(app.envFile.DATABASE_URL).toBe("postgres://localhost/dev");
      expect(app.envOverlay).toEqual({ DATABASE_URL: "postgres://127.0.0.1:15432/hf" });
    } finally {
      delete process.env.DATABASE_URL;
    }
  });

  it("refuses a directory with no registry rather than guessing at one", async () => {
    await expect(resolveApp(path.parse(process.cwd()).root)).rejects.toThrow(NotAnApp);
  });
});
