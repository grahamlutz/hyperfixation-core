import { createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mayEnrolPasskey, upgradeSessionFactor } from "./factory.js";
import { resetSecondFactor } from "./reset-second-factor.js";

/** `$4` is the offset from the session's own `created_at`, so the ordering is the test's point. */
const INSERT_PASSKEY =
  "INSERT INTO hf_passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up, created_at) " +
  "VALUES ($1, 'device', 'pk', $2, $1, 0, 'singleDevice', true, " +
  "(SELECT created_at FROM hf_session WHERE token = $3) + $4::interval)";

const INSERT_SESSION =
  "INSERT INTO hf_session (id, expires_at, token, user_id, factor) " +
  "VALUES ($1, now() + $4::interval, $1, $2, $3)";

describe("enrolling a passkey and promoting the session that did", () => {
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
        "('u-one', 'One', 'one@app.test', 'member'), " +
        "('u-two', 'Two', 'two@app.test', 'member')",
    );
    await pool.query(INSERT_SESSION, ["s-code", "u-one", "code", "1 day"]);
  });

  const factorOf = async (token: string): Promise<string | undefined> => {
    const { rows } = await pool.query<{ factor: string }>(
      "SELECT factor FROM hf_session WHERE token = $1",
      [token],
    );
    return rows[0]?.factor;
  };

  const enrol = (id: string, userId: string, token: string, offset: string): Promise<unknown> =>
    pool.query(INSERT_PASSKEY, [id, userId, token, offset]);

  describe("the promotion", () => {
    it("refuses a code session that enrolled nothing", async () => {
      // The whole exploit in one line: the ceremony is client-side, so reaching the action is
      // not evidence that it ran. Without a row there is nothing to promote on.
      expect(await upgradeSessionFactor(pool, "s-code")).toBe(false);
      expect(await factorOf("s-code")).toBe("code");
    });

    it("promotes once a passkey was enrolled during the session", async () => {
      await enrol("pk-new", "u-one", "s-code", "1 second");

      expect(await upgradeSessionFactor(pool, "s-code")).toBe(true);
      expect(await factorOf("s-code")).toBe("passkey");

      // Already the stronger factor: a second call changes nothing and says so.
      expect(await upgradeSessionFactor(pool, "s-code")).toBe(false);
      expect(await upgradeSessionFactor(pool, "no-such-token")).toBe(false);
    });

    it("does not promote on a passkey the user already held", async () => {
      await enrol("pk-old", "u-one", "s-code", "-1 hour");

      expect(await upgradeSessionFactor(pool, "s-code")).toBe(false);
      expect(await factorOf("s-code")).toBe("code");
    });

    it("does not promote on somebody else's enrolment", async () => {
      await enrol("pk-other", "u-two", "s-code", "1 second");

      expect(await upgradeSessionFactor(pool, "s-code")).toBe(false);
    });

    it("does not promote an expired session", async () => {
      await pool.query(INSERT_SESSION, ["s-dead", "u-one", "code", "-1 second"]);
      await enrol("pk-dead", "u-one", "s-dead", "1 second");

      expect(await upgradeSessionFactor(pool, "s-dead")).toBe(false);
    });

    it("updates one row when two calls race, because it is one statement", async () => {
      await enrol("pk-race", "u-one", "s-code", "1 second");

      const results = await Promise.all([
        upgradeSessionFactor(pool, "s-code"),
        upgradeSessionFactor(pool, "s-code"),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await factorOf("s-code")).toBe("passkey");
    });
  });

  describe("who may run the enrolment ceremony", () => {
    it("lets a code session enrol the first passkey — it is the bootstrap factor", async () => {
      expect(await mayEnrolPasskey(pool, "s-code")).toBe(true);
    });

    it("refuses a code session once the user already holds one", async () => {
      // Otherwise the inbox alone enrols the attacker's own authenticator and the promotion
      // that follows is legitimate.
      await enrol("pk-old", "u-one", "s-code", "-1 hour");

      expect(await mayEnrolPasskey(pool, "s-code")).toBe(false);
    });

    it("refuses when the row cannot say when it was enrolled", async () => {
      await enrol("pk-old", "u-one", "s-code", "-1 hour");
      await pool.query("UPDATE hf_passkey SET created_at = NULL WHERE id = 'pk-old'");

      expect(await mayEnrolPasskey(pool, "s-code")).toBe(false);
    });

    it("lets a passkey session add another authenticator", async () => {
      await pool.query(INSERT_SESSION, ["s-passkey", "u-one", "passkey", "1 day"]);
      await enrol("pk-old", "u-one", "s-passkey", "-1 hour");

      expect(await mayEnrolPasskey(pool, "s-passkey")).toBe(true);
    });

    it("ignores another user's passkeys", async () => {
      await enrol("pk-other", "u-two", "s-code", "-1 hour");

      expect(await mayEnrolPasskey(pool, "s-code")).toBe(true);
    });

    it("reopens enrolment after an admin reset, which is the recovery path", async () => {
      await enrol("pk-lost", "u-one", "s-code", "-1 hour");
      expect(await mayEnrolPasskey(pool, "s-code")).toBe(false);

      await resetSecondFactor(pool, { userId: "u-one", actorId: "u-two" });

      // The reset revokes every session too, so recovery is a fresh code sign-in and then a
      // first enrolment — which is now allowed again because the old rows are gone.
      await pool.query(INSERT_SESSION, ["s-again", "u-one", "code", "1 day"]);
      expect(await mayEnrolPasskey(pool, "s-again")).toBe(true);
    });
  });
});
