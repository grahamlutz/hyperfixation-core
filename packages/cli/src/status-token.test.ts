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
      const result = await statusTokenApp({ dir, kinds: ["read"], explicit: true });

      expect(result.tokens).toEqual({ read: result.tokens.read });
      const { rows } = await asRole(db.migratorUrl, (pg) =>
        pg.query<{ read_token_hash: string | null; write_token_hash: string | null }>(
          "SELECT read_token_hash, write_token_hash FROM hf_app_state WHERE id = 1",
        ),
      );
      expect(rows[0]!.read_token_hash).not.toBeNull();
      expect(rows[0]!.write_token_hash).toBeNull();
    });

    it("a default two-kind run fills in only the unset one, leaving the live one untouched", async () => {
      const first = await statusTokenApp({ dir, kinds: ["read"], explicit: true });

      const result = await statusTokenApp({ dir });

      expect(result.tokens.read).toBeUndefined();
      expect(result.tokens.write).toBeTypeOf("string");
      const { rows } = await asRole(db.migratorUrl, (pg) =>
        pg.query<{ read_token_hash: string; write_token_hash: string }>(
          "SELECT read_token_hash, write_token_hash FROM hf_app_state WHERE id = 1",
        ),
      );
      expect(rows[0]!.read_token_hash).toBe(hashStatusToken(first.tokens.read!));
      expect(rows[0]!.write_token_hash).toBe(hashStatusToken(result.tokens.write!));
    });

    it("refuses an explicit --read/--write for a kind that is already set", async () => {
      await statusTokenApp({ dir, kinds: ["read"], explicit: true });

      const refusal = await statusTokenApp({
        dir,
        kinds: ["read", "write"],
        explicit: true,
      }).catch((e: unknown) => e);
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
      const first = await statusTokenApp({ dir, kinds: ["write"], explicit: true });
      const second = await statusTokenApp({ dir, kinds: ["write"], explicit: true, rotate: true });

      expect(second.tokens.write).not.toBe(first.tokens.write);
      const { rows } = await asRole(db.migratorUrl, (pg) =>
        pg.query<{ write_token_hash: string }>(
          "SELECT write_token_hash FROM hf_app_state WHERE id = 1",
        ),
      );
      expect(rows[0]!.write_token_hash).toBe(hashStatusToken(second.tokens.write!));
    });

    it("runs against an app with no .env at all, on the overlay alone — the cloud's case", async () => {
      // No DATABASE_URL in this dir's `.env`, and a stale one in the file to be beaten: `hf new`
      // provisions through the E2 tunnel, before the app has a `.env` anywhere.
      const cloud = await fakeApp({
        appName: db.appName,
        env: { DATABASE_URL: "postgres://nobody@127.0.0.1:1/dev" },
      });
      try {
        const result = await statusTokenApp({
          dir: cloud,
          kinds: ["read"],
          explicit: true,
          env: { DATABASE_URL: db.applicationUrl },
        });

        expect(result.tokens.read).toBeTypeOf("string");
      } finally {
        await rm(cloud, { recursive: true, force: true });
      }
    }, 30_000);

    it("audits what it provisioned, and only that — never the plaintext", async () => {
      const result = await statusTokenApp({ dir, kinds: ["read"], explicit: true });

      const { rows } = await asRole(db.migratorUrl, (pg) =>
        pg.query<{ action: string; meta: { kinds: string[] } }>(
          "SELECT action, meta FROM hf_audit ORDER BY id",
        ),
      );
      expect(rows).toEqual([{ action: "app.status_token_provisioned", meta: { kinds: ["read"] } }]);
      expect(JSON.stringify(rows)).not.toContain(result.tokens.read);
    });
  });
});
