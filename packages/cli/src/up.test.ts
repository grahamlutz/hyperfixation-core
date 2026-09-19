import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveApp } from "./app.js";
import { fakeApp } from "./test-support/fake-app.js";
import { bootstrapIfNeeded, DEV_BUDGET_USD, needsInstall, usesDefaultBudget } from "./up.js";

describe("needsInstall", () => {
  it("is true when node_modules isn't there yet", async () => {
    const dir = await fakeApp({ appName: "demo_app" });
    try {
      expect(await needsInstall(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is false once node_modules exists, so hf up skips a redundant install", async () => {
    const dir = await fakeApp({ appName: "demo_app" });
    try {
      await mkdir(path.join(dir, "node_modules"), { recursive: true });
      expect(await needsInstall(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("bootstrapIfNeeded", () => {
  let db: TestDatabase;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await fakeApp({
      appName: db.appName,
      env: {
        DATABASE_URL: db.applicationUrl,
        MIGRATOR_DATABASE_URL: db.migratorUrl,
        HF_BOOTSTRAP_BUDGET_USD: "50",
        HF_BOOTSTRAP_EMAIL: "graham@example.com",
      },
    });
  }, 90_000);

  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    await db?.drop();
  });

  it("runs hf bootstrap and reports it ran, on an app with no admin yet", async () => {
    const app = await resolveApp(dir);
    expect(await bootstrapIfNeeded(app)).toBe(true);

    const row = await asRole(db.applicationUrl, (pg) =>
      pg.query("SELECT email FROM hf_user WHERE email = 'graham@example.com'"),
    );
    expect(row.rows).toHaveLength(1);
  }, 30_000);

  it("skips cleanly on a rerun, rather than throwing BootstrapRefused", async () => {
    const app = await resolveApp(dir);
    expect(await bootstrapIfNeeded(app)).toBe(false);
  }, 30_000);
});

describe("bootstrapIfNeeded with no HF_BOOTSTRAP_BUDGET_USD", () => {
  let db: TestDatabase;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await fakeApp({
      appName: db.appName,
      env: {
        DATABASE_URL: db.applicationUrl,
        MIGRATOR_DATABASE_URL: db.migratorUrl,
        HF_BOOTSTRAP_EMAIL: "graham@example.com",
      },
    });
  }, 90_000);

  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    await db?.drop();
  });

  it("seeds the dev default budget rather than stopping on MissingEnv", async () => {
    const app = await resolveApp(dir);
    expect(usesDefaultBudget(app)).toBe(true);
    expect(await bootstrapIfNeeded(app)).toBe(true);

    const row = await asRole(db.applicationUrl, (pg) =>
      pg.query("SELECT budget_usd::numeric AS budget FROM hf_app_state WHERE id = 1"),
    );
    expect(Number(row.rows[0].budget)).toBe(Number(DEV_BUDGET_USD));
  }, 30_000);
});

describe("usesDefaultBudget", () => {
  it("is false when the app's .env sets a budget", async () => {
    const dir = await fakeApp({ appName: "demo_app", env: { HF_BOOTSTRAP_BUDGET_USD: "50" } });
    try {
      expect(usesDefaultBudget(await resolveApp(dir))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
