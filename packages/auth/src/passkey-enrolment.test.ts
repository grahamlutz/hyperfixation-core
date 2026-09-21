import { createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { APIError } from "better-auth/api";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  mayEnrolPasskey,
  passkeyEndpointAllowed,
  passkeyRegistrationSucceeded,
  stampPasskeyEnrolment,
  upgradeSessionFactor,
} from "./factory.js";
import { resetSecondFactor } from "./reset-second-factor.js";
import {
  PASSKEY_AUTHENTICATION_OPTIONS_PATH,
  PASSKEY_AUTHENTICATION_PATH,
  PASSKEY_REGISTRATION_OPTIONS_PATH,
  PASSKEY_REGISTRATION_PATH,
} from "./session.js";

/**
 * Every `/passkey/*` endpoint `@better-auth/passkey` 1.7.5 exposes, read off its source. The
 * three management ones are the reason the gate is an inversion: each asks for a session and, on
 * two of them, ownership — never a factor — so a code session that reaches `delete-passkey`
 * erases the victim's authenticators and is a "first enrolment" again.
 */
const MANAGEMENT_PATHS = [
  "/passkey/list-user-passkeys",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
];
const REGISTRATION_PATHS = [PASSKEY_REGISTRATION_OPTIONS_PATH, PASSKEY_REGISTRATION_PATH];
const SIGN_IN_PATHS = [PASSKEY_AUTHENTICATION_OPTIONS_PATH, PASSKEY_AUTHENTICATION_PATH];

const INSERT_PASSKEY =
  "INSERT INTO hf_passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up) " +
  "VALUES ($1, 'device', 'pk', $2, $1, 0, 'singleDevice', true)";

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

  const stampedTokens = async (): Promise<string[]> => {
    const { rows } = await pool.query<{ token: string }>(
      "SELECT s.token FROM hf_session_passkey_enrolment e " +
        "JOIN hf_session s ON s.id = e.session_id ORDER BY s.token",
    );
    return rows.map((row) => row.token);
  };

  const stampRowCount = async (): Promise<number> => {
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM hf_session_passkey_enrolment",
    );
    return Number(rows[0]?.count);
  };

  const enrol = (id: string, userId: string): Promise<unknown> =>
    pool.query(INSERT_PASSKEY, [id, userId]);

  /** What a real ceremony leaves behind: the `hf_passkey` row *and* the stamp on its session. */
  const completeEnrolment = async (id: string, userId: string, token: string): Promise<void> => {
    await enrol(id, userId);
    await stampPasskeyEnrolment(pool, token);
  };

  describe("the promotion", () => {
    it("refuses a code session that enrolled nothing", async () => {
      // The whole exploit in one line: the ceremony is client-side, so reaching the action is
      // not evidence that it ran.
      expect(await upgradeSessionFactor(pool, "s-code")).toBe(false);
      expect(await factorOf("s-code")).toBe("code");
    });

    it("promotes the session the ceremony stamped", async () => {
      await completeEnrolment("pk-new", "u-one", "s-code");

      expect(await upgradeSessionFactor(pool, "s-code")).toBe(true);
      expect(await factorOf("s-code")).toBe("passkey");

      // Already the stronger factor: a second call changes nothing and says so.
      expect(await upgradeSessionFactor(pool, "s-code")).toBe(false);
      expect(await upgradeSessionFactor(pool, "no-such-token")).toBe(false);
    });

    it("does not promote a sibling session of the same user", async () => {
      // The stamp is on a row, not on a user: one session enrolling does not lift the others.
      await pool.query(INSERT_SESSION, ["s-other", "u-one", "code", "1 day"]);
      await completeEnrolment("pk-new", "u-one", "s-code");

      expect(await upgradeSessionFactor(pool, "s-other")).toBe(false);
      expect(await factorOf("s-other")).toBe("code");
    });

    it("does not promote an untouched code session when the user adds a second device", async () => {
      // The break the first fix had. Its predicate was "a passkey newer than this session
      // exists", which is a clock, not a session: the victim holds an old authenticator, the
      // attacker's inbox-only session sits idle, and an hour later the victim legitimately
      // enrols a second device from their own passkey session — promoting the attacker.
      await enrol("pk-old", "u-one");
      await pool.query(INSERT_SESSION, ["s-attacker", "u-one", "code", "1 day"]);
      await pool.query(INSERT_SESSION, ["s-victim", "u-one", "passkey", "1 day"]);

      await completeEnrolment("pk-second-device", "u-one", "s-victim");

      expect(await upgradeSessionFactor(pool, "s-attacker")).toBe(false);
      expect(await factorOf("s-attacker")).toBe("code");
    });

    it("does not promote on somebody else's enrolment", async () => {
      await pool.query(INSERT_SESSION, ["s-two", "u-two", "code", "1 day"]);
      await completeEnrolment("pk-two", "u-two", "s-two");

      expect(await upgradeSessionFactor(pool, "s-code")).toBe(false);
    });

    it("refuses once the stamp row is gone, however the row left", async () => {
      await completeEnrolment("pk-new", "u-one", "s-code");
      await pool.query("DELETE FROM hf_session_passkey_enrolment");

      expect(await upgradeSessionFactor(pool, "s-code")).toBe(false);
      expect(await factorOf("s-code")).toBe("code");
    });

    it("does not promote a stamped session whose user holds no authenticator", async () => {
      // Belt and braces: the stamp survives a later `delete-passkey`, and a stamp with nothing
      // behind it is not something to hand the stronger factor to.
      await completeEnrolment("pk-gone", "u-one", "s-code");
      await pool.query("DELETE FROM hf_passkey WHERE id = 'pk-gone'");

      expect(await upgradeSessionFactor(pool, "s-code")).toBe(false);
    });

    it("does not promote an expired session", async () => {
      await pool.query(INSERT_SESSION, ["s-dead", "u-one", "code", "-1 second"]);
      await completeEnrolment("pk-dead", "u-one", "s-dead");

      expect(await upgradeSessionFactor(pool, "s-dead")).toBe(false);
    });

    it("updates one row when two calls race, because it is one statement", async () => {
      await completeEnrolment("pk-race", "u-one", "s-code");

      const results = await Promise.all([
        upgradeSessionFactor(pool, "s-code"),
        upgradeSessionFactor(pool, "s-code"),
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await factorOf("s-code")).toBe("passkey");
    });
  });

  describe("the stamp", () => {
    it("marks the named session and no other", async () => {
      await pool.query(INSERT_SESSION, ["s-other", "u-one", "code", "1 day"]);

      expect(await stampPasskeyEnrolment(pool, "s-code")).toBe(true);
      expect(await stampedTokens()).toEqual(["s-code"]);
    });

    it("says so when the token names nothing, and leaves no row behind", async () => {
      // The insert selects the session id rather than taking one, so a foreign token writes
      // nothing at all — there is no orphan row for a later session to inherit.
      expect(await stampPasskeyEnrolment(pool, "no-such-token")).toBe(false);
      expect(await stampRowCount()).toBe(0);
    });

    it("lets the first stamp stand when the same session registers twice", async () => {
      expect(await stampPasskeyEnrolment(pool, "s-code")).toBe(true);
      expect(await stampPasskeyEnrolment(pool, "s-code")).toBe(false);
      expect(await stampRowCount()).toBe(1);
    });

    it("goes when the session goes, so the proof never outlives it", async () => {
      await completeEnrolment("pk-new", "u-one", "s-code");

      await pool.query("DELETE FROM hf_session WHERE token = 's-code'");

      expect(await stampRowCount()).toBe(0);
    });
  });

  describe("reading whether a registration succeeded", () => {
    it("takes the created passkey row as the proof", () => {
      expect(passkeyRegistrationSucceeded({ id: "pk-1", userId: "u-one" })).toBe(true);
    });

    it("refuses anything that is not one", () => {
      // better-auth parks a thrown `APIError` in `ctx.context.returned` and runs the after-hooks
      // anyway, so this is the difference between a verified ceremony and a POST of junk.
      expect(passkeyRegistrationSucceeded(new APIError("BAD_REQUEST"))).toBe(false);
      // An error is an error whatever it happens to carry, so the two halves of the check are
      // both refusals rather than one guarding the other.
      expect(
        passkeyRegistrationSucceeded(Object.assign(new APIError("BAD_REQUEST"), { id: "pk-1" })),
      ).toBe(false);
      expect(passkeyRegistrationSucceeded(undefined)).toBe(false);
      expect(passkeyRegistrationSucceeded(null)).toBe(false);
      expect(passkeyRegistrationSucceeded({ status: "BAD_REQUEST" })).toBe(false);
    });
  });

  describe("which passkey endpoints a factor may drive", () => {
    it("lets a code session start the ceremony while the user has none — the bootstrap", async () => {
      for (const path of REGISTRATION_PATHS) {
        expect(await passkeyEndpointAllowed(pool, "s-code", path)).toBe(true);
      }
      expect(await mayEnrolPasskey(pool, "s-code")).toBe(true);
    });

    it("refuses a code session every management endpoint, passkey or not", async () => {
      // `delete-passkey` is the one that mattered: with it the enrolment gate below undoes
      // itself — erase the victim's authenticators, become a first enrolment, enrol your own.
      for (const path of MANAGEMENT_PATHS) {
        expect(await passkeyEndpointAllowed(pool, "s-code", path)).toBe(false);
      }

      await enrol("pk-old", "u-one");
      for (const path of MANAGEMENT_PATHS) {
        expect(await passkeyEndpointAllowed(pool, "s-code", path)).toBe(false);
      }
    });

    it("refuses a code session the ceremony once the user already holds one", async () => {
      await enrol("pk-old", "u-one");

      for (const path of REGISTRATION_PATHS) {
        expect(await passkeyEndpointAllowed(pool, "s-code", path)).toBe(false);
      }
      expect(await mayEnrolPasskey(pool, "s-code")).toBe(false);
    });

    it("refuses a code session an endpoint this file has never heard of", async () => {
      // The inversion: a plugin upgrade that adds a fifth authenticated endpoint is refused
      // before anyone has read its release notes.
      expect(await passkeyEndpointAllowed(pool, "s-code", "/passkey/some-future-endpoint")).toBe(
        false,
      );
    });

    it("lets a passkey session drive all of them", async () => {
      await pool.query(INSERT_SESSION, ["s-passkey", "u-one", "passkey", "1 day"]);
      await enrol("pk-old", "u-one");

      for (const path of [...REGISTRATION_PATHS, ...MANAGEMENT_PATHS, ...SIGN_IN_PATHS]) {
        expect(await passkeyEndpointAllowed(pool, "s-passkey", path)).toBe(true);
      }
      expect(await mayEnrolPasskey(pool, "s-passkey")).toBe(true);
    });

    it("ignores another user's passkeys", async () => {
      await enrol("pk-other", "u-two");

      expect(await mayEnrolPasskey(pool, "s-code")).toBe(true);
    });

    it("leaves an unknown token to better-auth's own session middleware", async () => {
      expect(await passkeyEndpointAllowed(pool, "no-such-token", "/passkey/delete-passkey")).toBe(
        true,
      );
    });

    it("reopens enrolment after an admin reset, which is the recovery path", async () => {
      await enrol("pk-lost", "u-one");
      expect(await mayEnrolPasskey(pool, "s-code")).toBe(false);

      await resetSecondFactor(pool, { userId: "u-one", actorId: "u-two" });

      // The reset revokes every session too, so recovery is a fresh code sign-in and then a
      // first enrolment — which is now allowed again because the old rows are gone.
      await pool.query(INSERT_SESSION, ["s-again", "u-one", "code", "1 day"]);
      expect(await mayEnrolPasskey(pool, "s-again")).toBe(true);
    });
  });
});
