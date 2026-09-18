import { rm } from "node:fs/promises";
import { BootstrapRefused } from "@hyperfixation/auth";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
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
      env: {
        DATABASE_URL: db.applicationUrl,
        MIGRATOR_DATABASE_URL: db.migratorUrl,
        HF_BOOTSTRAP_BUDGET_USD: "50",
      },
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

  it("seeds the hf_app_state singleton with HF_BOOTSTRAP_BUDGET_USD", async () => {
    const row = await asRole(db.applicationUrl, (pg) =>
      pg.query("SELECT paused, budget_usd FROM hf_app_state WHERE id = 1"),
    );

    expect(row.rows).toMatchObject([{ paused: false, budget_usd: "50.0000" }]);
  }, 30_000);

  it("refuses the second run, because an app gets exactly one bootstrap admin", async () => {
    await expect(bootstrapApp({ dir, email: "someone@example.com" })).rejects.toThrow(
      BootstrapRefused,
    );
  }, 30_000);

  it("leaves hf_app_state alone on a rerun, rather than overwriting the budget", async () => {
    const empty = await fakeApp({
      appName: "demo_app",
      env: { DATABASE_URL: db.applicationUrl, HF_BOOTSTRAP_BUDGET_USD: "999" },
    });
    try {
      await expect(bootstrapApp({ dir: empty, email: "again@example.com" })).rejects.toThrow(
        BootstrapRefused,
      );

      const row = await asRole(db.applicationUrl, (pg) =>
        pg.query("SELECT budget_usd FROM hf_app_state WHERE id = 1"),
      );
      expect(row.rows).toMatchObject([{ budget_usd: "50.0000" }]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses with no address at all rather than picking one", async () => {
    const empty = await fakeApp({
      appName: "demo_app",
      env: { DATABASE_URL: db.applicationUrl, HF_BOOTSTRAP_BUDGET_USD: "50" },
    });
    try {
      await expect(bootstrapApp({ dir: empty })).rejects.toThrow(MissingEnv);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("refuses with no budget set at all", async () => {
    const empty = await fakeApp({ appName: "demo_app", env: { DATABASE_URL: db.applicationUrl } });
    try {
      await expect(bootstrapApp({ dir: empty, email: "someone@example.com" })).rejects.toThrow(
        MissingEnv,
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("accepts --budget-usd in place of HF_BOOTSTRAP_BUDGET_USD, like --email does for the address", async () => {
    // No HF_BOOTSTRAP_BUDGET_USD in this dir's .env: only `budgetUsd` clears `requireEnv`'s
    // refusal. The run still fails past that point — the shared `db` already has an admin from
    // the first test in this suite — which is exactly what proves the env var was never read.
    const empty = await fakeApp({ appName: "demo_app2", env: { DATABASE_URL: db.applicationUrl } });
    try {
      await expect(
        bootstrapApp({ dir: empty, email: "flagged@example.com", budgetUsd: "75" }),
      ).rejects.toThrow(BootstrapRefused);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("refuses a non-positive budget", async () => {
    const empty = await fakeApp({
      appName: "demo_app",
      env: { DATABASE_URL: db.applicationUrl, HF_BOOTSTRAP_BUDGET_USD: "0" },
    });
    try {
      await expect(bootstrapApp({ dir: empty, email: "someone@example.com" })).rejects.toThrow(
        /positive number/,
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
