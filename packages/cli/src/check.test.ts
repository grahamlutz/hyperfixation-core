import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkApp } from "./check.js";
import { fakeApp } from "./test-support/fake-app.js";

const codes = (result: { findings: readonly { code: string }[] }): string[] =>
  result.findings.map((finding) => finding.code);

describe("hf check", () => {
  let db: TestDatabase;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    dir = await fakeApp({
      appName: db.appName,
      env: { DATABASE_URL: db.applicationUrl, MIGRATOR_DATABASE_URL: db.migratorUrl },
      declared: ["DATABASE_URL", "MIGRATOR_DATABASE_URL", "APP_URL"],
    });
  }, 90_000);

  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    await db?.drop();
  });

  it("names a var .env.example declares and the environment does not carry", async () => {
    const result = await checkApp({ dir });

    expect(codes(result)).toContain("env");
    expect(result.findings.find((f) => f.code === "env")?.message).toContain("APP_URL");
  }, 30_000);

  it("passes E001-E006 against a freshly migrated database", async () => {
    const result = await checkApp({ dir });

    expect(codes(result).filter((code) => code.startsWith("E"))).toEqual([]);
  }, 30_000);

  it("reports an app migration that is in the tree and not in the database", async () => {
    await writeFile(
      path.join(dir, "drizzle", "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [{ idx: 0, version: "7", when: 1, tag: "0000_pending", breakpoints: true }],
      }),
    );

    const result = await checkApp({ dir });

    expect(result.findings.find((f) => f.code === "migrations")?.message).toContain(
      "1 app migration(s) pending",
    );
  }, 30_000);

  it("says so when the registry could not be read, rather than passing E001-E003 vacuously", async () => {
    const result = await checkApp({ dir });

    // The fake app has no `node_modules`, so the probe cannot import `src/hyperfixation.ts`.
    expect(codes(result)).toContain("registry");
    expect(result.recordTables).toBeUndefined();
  }, 30_000);
});
