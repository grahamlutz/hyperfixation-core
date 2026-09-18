import { rm } from "node:fs/promises";
import { hashStatusToken } from "@hyperfixation/core";
import { AppStateMissing } from "@hyperfixation/db";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StatusTokenAlreadySet, statusTokenApp } from "./status-token.js";
import { fakeApp } from "./test-support/fake-app.js";

describe("hf status-token", () => {
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

  beforeEach(async () => {
    await asRole(db.migratorUrl, async (pg) => {
      await pg.query("DELETE FROM hf_audit");
      await pg.query("DELETE FROM hf_app_state");
    });
  });

  it("refuses before hf_app_state has a row, naming the app as unbootstrapped", async () => {
    await expect(statusTokenApp({ dir })).rejects.toThrow(AppStateMissing);
  });

  describe("against a seeded singleton", () => {
    beforeEach(async () => {
      await asRole(db.migratorUrl, async (pg) => {
        await pg.query("INSERT INTO hf_app_state (id, paused, budget_usd) VALUES (1, false, '100')");
      });
    });

    it("generates independent read and write tokens, hashed the same way statusTokenMatches checks", async () => {
      const result = await statusTokenApp({ dir });

      expect(result.tokens.read).toBeTypeOf("string");
      expect(result.tokens.write).toBeTypeOf("string");
      expect(result.tokens.read).not.toBe(result.tokens.write);

      const { rows } = await asRole(db.migratorUrl, (pg) =>
        pg.query<{ read_token_hash: string; write_token_hash: string }>(
          "SELECT read_token_hash, write_token_hash FROM hf_app_state WHERE id = 1",
        ),
      );
      expect(rows[0]).toEqual({
        read_token_hash: hashStatusToken(result.tokens.read!),
        write_token_hash: hashStatusToken(result.tokens.write!),
      });
    });

    it("provisions only the requested kind when --read or --write narrows it", async () => {
      const result = await statusTokenApp({ dir, kinds: ["read"] });

      expect(result.tokens).toEqual({ read: result.tokens.read });
      const { rows } = await asRole(db.migratorUrl, (pg) =>
        pg.query<{ read_token_hash: string | null; write_token_hash: string | null }>(
          "SELECT read_token_hash, write_token_hash FROM hf_app_state WHERE id = 1",
        ),
      );
      expect(rows[0]!.read_token_hash).not.toBeNull();
      expect(rows[0]!.write_token_hash).toBeNull();
    });

    it("refuses to overwrite a token that is already set, one kind at a time", async () => {
      await statusTokenApp({ dir, kinds: ["read"] });

      const refusal = await statusTokenApp({ dir, kinds: ["read", "write"] }).catch((e) => e);
      expect(refusal).toBeInstanceOf(StatusTokenAlreadySet);
      expect((refusal as StatusTokenAlreadySet).kind).toBe("read");

      const { rows } = await asRole(db.migratorUrl, (pg) =>
        pg.query<{ write_token_hash: string | null }>(
          "SELECT write_token_hash FROM hf_app_state WHERE id = 1",
        ),
      );
      expect(rows[0]!.write_token_hash).toBeNull();
    });

    it("replaces a set token when --rotate authorizes it, and the old token stops matching", async () => {
      const first = await statusTokenApp({ dir, kinds: ["write"] });
      const second = await statusTokenApp({ dir, kinds: ["write"], rotate: true });

      expect(second.tokens.write).not.toBe(first.tokens.write);
      const { rows } = await asRole(db.migratorUrl, (pg) =>
        pg.query<{ write_token_hash: string }>(
          "SELECT write_token_hash FROM hf_app_state WHERE id = 1",
        ),
      );
      expect(rows[0]!.write_token_hash).toBe(hashStatusToken(second.tokens.write!));
    });
  });
});
