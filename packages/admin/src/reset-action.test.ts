import {
  AccessRefused,
  createSessionGuard,
  type AuthSession,
  type RequireSession,
} from "@hyperfixation/auth";
import { createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminRouter } from "./router.js";

const INSERT_PASSKEY =
  "INSERT INTO hf_passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up) " +
  "VALUES ($1, $2, 'pk', $3, $1, 0, 'singleDevice', true)";

const INSERT_SESSION =
  "INSERT INTO hf_session (id, expires_at, token, user_id, factor) " +
  "VALUES ($1, now() + interval '1 day', $1, $2, $3)";

const ADMIN_SESSION: AuthSession = {
  factor: "passkey",
  user: { id: "u-admin", email: "admin@app.test", role: "admin" },
};

const MEMBER_SESSION: AuthSession = {
  factor: "passkey",
  user: { id: "u-other", email: "other@app.test", role: "member" },
};

describe("the reset-passkey action, as the admin exposes it", () => {
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
    await pool.query(INSERT_PASSKEY, ["pk-lost", "phone", "u-lost"]);
    await pool.query(INSERT_SESSION, ["s-lost", "u-lost", "passkey"]);
  });

  const guardFor = (current: AuthSession | null): { requireSession: RequireSession; notFound: ReturnType<typeof vi.fn> } => {
    const notFound = vi.fn();
    return {
      notFound,
      requireSession: createSessionGuard({
        getSession: () => Promise.resolve(current),
        onNotFound: notFound,
        onRedirect: vi.fn(),
      }),
    };
  };

  const countOf = async (statement: string, id: string): Promise<number> => {
    const { rows } = await pool.query<{ count: string }>(statement, [id]);
    return Number(rows[0]?.count ?? "0");
  };

  const passkeysOf = (id: string) =>
    countOf("SELECT count(*) AS count FROM hf_passkey WHERE user_id = $1", id);
  const sessionsOf = (id: string) =>
    countOf("SELECT count(*) AS count FROM hf_session WHERE user_id = $1", id);

  it("unenrols the user's passkeys and revokes their sessions", async () => {
    const { requireSession } = guardFor(ADMIN_SESSION);
    const router = createAdminRouter({ pool, requireSession });

    await expect(
      router.actions.resetSecondFactor({ userId: "u-lost", reason: "lost phone" }),
    ).resolves.toMatchObject({ userId: "u-lost", passkeysRemoved: 1, sessionsRevoked: 1 });

    expect(await passkeysOf("u-lost")).toBe(0);
    expect(await sessionsOf("u-lost")).toBe(0);
  });

  it("records the admin from the guarded session, not from whatever the caller passed", async () => {
    const { requireSession } = guardFor(ADMIN_SESSION);
    const router = createAdminRouter({ pool, requireSession });

    await router.actions.resetSecondFactor({ userId: "u-lost", actorId: "u-other" });

    const { rows } = await pool.query<{ actor_id: string; action: string; target_id: string }>(
      "SELECT actor_id, action, target_id FROM hf_audit",
    );
    expect(rows).toEqual([
      { actor_id: "u-admin", action: "auth.second_factor_reset", target_id: "u-lost" },
    ]);
  });

  it("is refused for a member, and nothing is deleted", async () => {
    const { requireSession, notFound } = guardFor(MEMBER_SESSION);
    const router = createAdminRouter({ pool, requireSession });

    await expect(router.actions.resetSecondFactor({ userId: "u-lost" })).rejects.toBeInstanceOf(
      AccessRefused,
    );
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(await passkeysOf("u-lost")).toBe(1);
    expect(await sessionsOf("u-lost")).toBe(1);
    expect(await countOf("SELECT count(*) AS count FROM hf_audit WHERE $1 = $1", "x")).toBe(0);
  });
});
