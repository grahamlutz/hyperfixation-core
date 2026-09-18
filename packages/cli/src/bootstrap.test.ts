import { rm } from "node:fs/promises";
import { BootstrapRefused } from "@hyperfixation/auth";
import { createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapApp } from "./bootstrap.js";
import { MissingEnv } from "./require-env.js";
import { fakeApp } from "./test-support/fake-app.js";

describe("hf bootstrap", () => {
  let db: TestDatabase;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await fakeApp({
      appName: db.appName,
      env: { DATABASE_URL: db.applicationUrl, MIGRATOR_DATABASE_URL: db.migratorUrl },
    });
  }, 90_000);

  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    await db?.drop();
  });

  it("creates the first admin as the application role, from the address --email names", async () => {
    const result = await bootstrapApp({ dir, email: "graham@example.com", name: "Graham" });

    expect(result).toMatchObject({ email: "graham@example.com", created: true });
    expect(result.app.appName).toBe(db.appName);
  }, 30_000);

  it("refuses the second run, because an app gets exactly one bootstrap admin", async () => {
    await expect(bootstrapApp({ dir, email: "someone@example.com" })).rejects.toThrow(
      BootstrapRefused,
    );
  }, 30_000);

  it("refuses with no address at all rather than picking one", async () => {
    const empty = await fakeApp({ appName: "demo_app", env: { DATABASE_URL: db.applicationUrl } });
    try {
      await expect(bootstrapApp({ dir: empty })).rejects.toThrow(MissingEnv);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
