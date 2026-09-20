import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Its own file, and a fresh module per case: the mode is process state, like the fixture warning
 * beside it, so a case that built a registry must not be the setup of the next one.
 */
const freshProviders = async (): Promise<typeof import("./providers.js")> => {
  vi.resetModules();
  return import("./providers.js");
};

describe("the providers mode", () => {
  it("is unknown until a registry is built", async () => {
    const { providersMode } = await freshProviders();

    expect(providersMode()).toBe("unknown");
  });

  it("is fixtures when no provider key is set", async () => {
    const { createProviders, providersMode } = await freshProviders();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      createProviders({ fixtures: { dir: "/nowhere" } }).model("claude-sonnet-4-5");
    } finally {
      warn.mockRestore();
    }

    expect(providersMode()).toBe("fixtures");
  });

  it("is live when a provider key is set", async () => {
    const { createProviders, providersMode } = await freshProviders();
    createProviders({ anthropic: { apiKey: "not-a-key" }, fixtures: { dir: "/nowhere" } });

    expect(providersMode()).toBe("live");
  });

  it("stays fixtures once one registry has served them", async () => {
    const { createProviders, providersMode } = await freshProviders();
    createProviders({ fixtures: { dir: "/nowhere" } });
    createProviders({ anthropic: { apiKey: "not-a-key" } });

    expect(providersMode()).toBe("fixtures");
  });

  it("leaves the mode alone for a registry with neither a key nor fixtures", async () => {
    const { createProviders, providersMode } = await freshProviders();
    createProviders();

    expect(providersMode()).toBe("unknown");
  });
});

describe("reporting the providers mode", () => {
  let database: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = new Pool({ max: 2, connectionString: database.applicationUrl });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query("DELETE FROM hf_app_state");
      await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, '100')");
    });
  });

  const stored = async (): Promise<string | null> => {
    const { rows } = await pool.query<{ llm_mode: string | null }>(
      "SELECT llm_mode FROM hf_app_state WHERE id = 1",
    );
    return rows[0]!.llm_mode;
  };

  it("records what the process serves", async () => {
    const { createProviders, reportProvidersMode } = await freshProviders();
    createProviders({ openai: { apiKey: "not-a-key" } });

    await expect(reportProvidersMode(pool)).resolves.toBe("live");
    await expect(stored()).resolves.toBe("live");
  });

  it("writes nothing from a process that built no registry", async () => {
    const { reportProvidersMode } = await freshProviders();
    await pool.query("UPDATE hf_app_state SET llm_mode = 'fixtures' WHERE id = 1");

    await expect(reportProvidersMode(pool)).resolves.toBe("unknown");
    // The worker's answer survives a report from a process that has nothing to say.
    await expect(stored()).resolves.toBe("fixtures");
  });
});
