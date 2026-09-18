import { createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionGuard } from "./require-session.js";
import { createResetSecondFactorAction, resetSecondFactor } from "./reset-second-factor.js";
import type { AuthSession } from "./session.js";

const INSERT_PASSKEY =
  "INSERT INTO hf_passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up) " +
  "VALUES ($1, $2, 'pk', $3, $1, 0, 'singleDevice', true)";

const INSERT_SESSION =
  "INSERT INTO hf_session (id, expires_at, token, user_id, factor) " +
  "VALUES ($1, now() + interval '1 day', $1, $2, $3)";

describe("resetting a second factor", () => {
  let database: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = new Pool({ connectionString: database.applicationUrl, max: 4 });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM hf_user");
    await pool.query("DELETE FROM hf_audit");
    await pool.query(
      "INSERT INTO hf_user (id, name, email, role) VALUES " +
        "('u-lost', 'Lost Device', 'lost@app.test', 'member'), " +
        "('u-admin', 'Admin', 'admin@app.test', 'admin'), " +
        "('u-other', 'Other', 'other@app.test', 'member')",
    );
    await pool.query(INSERT_PASSKEY, ["pk-lost-1", "phone", "u-lost"]);
    await pool.query(INSERT_PASSKEY, ["pk-lost-2", "laptop", "u-lost"]);
    await pool.query(INSERT_PASSKEY, ["pk-other", "phone", "u-other"]);
    await pool.query(INSERT_SESSION, ["s-lost-passkey", "u-lost", "passkey"]);
    await pool.query(INSERT_SESSION, ["s-lost-code", "u-lost", "code"]);
    await pool.query(INSERT_SESSION, ["s-other", "u-other", "passkey"]);
  });

  const idsIn = async (table: string, column: string, value: string): Promise<string[]> => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE ${column} = $1 ORDER BY id`,
      [value],
    );
    return rows.map((row) => row.id);
  };

  it("unenrols every passkey the user holds and nobody else's", async () => {
    const result = await resetSecondFactor(pool, { userId: "u-lost", actorId: "u-admin" });

    expect(result).toEqual({ userId: "u-lost", passkeysRemoved: 2, sessionsRevoked: 2 });
    expect(await idsIn("hf_passkey", "user_id", "u-lost")).toEqual([]);
    expect(await idsIn("hf_passkey", "user_id", "u-other")).toEqual(["pk-other"]);
  });

  it("revokes the code-factor session too, not only the passkey one", async () => {
    // A surviving code session reaches `/auth/*`, and `/auth/*` is where enrolment lives: the
    // holder of the lost device would enrol a fresh authenticator and be back where we started.
    await resetSecondFactor(pool, { userId: "u-lost", actorId: "u-admin" });

    expect(await idsIn("hf_session", "user_id", "u-lost")).toEqual([]);
    expect(await idsIn("hf_session", "user_id", "u-other")).toEqual(["s-other"]);
  });

  it("names the admin who did it in the audit row", async () => {
    await resetSecondFactor(pool, {
      userId: "u-lost",
      actorId: "u-admin",
      reason: "phone stolen",
    });

    const { rows } = await pool.query<{
      actor_id: string;
      action: string;
      target_id: string;
      meta: unknown;
    }>("SELECT actor_id, action, target_id, meta FROM hf_audit");
    expect(rows).toEqual([
      {
        actor_id: "u-admin",
        action: "auth.second_factor_reset",
        target_id: "u-lost",
        meta: { passkeysRemoved: 2, sessionsRevoked: 2, reason: "phone stolen" },
      },
    ]);
  });

  it("is a no-op on a user who had none, rather than an error", async () => {
    const result = await resetSecondFactor(pool, { userId: "u-admin", actorId: "u-admin" });
    expect(result).toEqual({ userId: "u-admin", passkeysRemoved: 0, sessionsRevoked: 0 });
  });

  describe("as the admin action", () => {
    const action = (session: AuthSession | null, onNotFound: () => never) =>
      createResetSecondFactorAction({
        pool,
        requireSession: createSessionGuard({ getSession: async () => session, onNotFound }),
      });

    const notFound = (): never => {
      throw new Error("not found");
    };

    it("takes the actor from the guarded session, not from the caller", async () => {
      const admin: AuthSession = { factor: "passkey", user: { id: "u-admin", role: "admin" } };

      await action(admin, notFound)({ userId: "u-lost", actorId: "u-lost" });

      const { rows } = await pool.query<{ actor_id: string }>("SELECT actor_id FROM hf_audit");
      expect(rows).toEqual([{ actor_id: "u-admin" }]);
    });

    it("404s a member, a code-factor admin and a stranger, and resets nothing", async () => {
      const member: AuthSession = { factor: "passkey", user: { id: "u-other", role: "member" } };
      const codeAdmin: AuthSession = { factor: "code", user: { id: "u-admin", role: "admin" } };

      for (const session of [member, codeAdmin, null]) {
        const refused = vi.fn(notFound);
        await expect(action(session, refused)({ userId: "u-lost" })).rejects.toThrow("not found");
        expect(refused).toHaveBeenCalledOnce();
      }

      expect(await idsIn("hf_passkey", "user_id", "u-lost")).toEqual(["pk-lost-1", "pk-lost-2"]);
      expect(await idsIn("hf_audit", "target_type", "user")).toEqual([]);
    });
  });
});
