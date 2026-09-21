import { createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth, upgradeSessionFactor } from "./factory.js";

/** The codes the factory would have emailed, in the order it asked for them. */
const sent: { email: string; otp: string }[] = [];

describe("the better-auth factory against the hf_* tables", () => {
  let database: TestDatabase;
  let pool: Pool;
  let auth: ReturnType<typeof createAuth>;

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = new Pool({ connectionString: database.applicationUrl, max: 4 });
    auth = createAuth({
      pool,
      baseURL: "https://app.test",
      secret: "test-secret-test-secret-test-secret",
      sendVerificationOTP: async ({ email, otp }) => {
        sent.push({ email, otp });
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    sent.length = 0;
    await pool.query("DELETE FROM hf_user");
    await pool.query("DELETE FROM hf_verification");
    await pool.query(
      "INSERT INTO hf_user (id, name, email, email_verified, role) " +
        "VALUES ('u-member', 'Member', 'member@app.test', true, 'member')",
    );
  });

  const signInByCode = async (email: string): Promise<string> => {
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    const otp = sent.at(-1)!.otp;
    await auth.api.signInEmailOTP({ body: { email, otp } });
    return latestSessionToken(email);
  };

  /** The same sign-in, kept as the `Cookie` header an endpoint is actually driven with. */
  const signInWithCookie = async (email: string): Promise<string> => {
    await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" } });
    const otp = sent.at(-1)!.otp;
    const { headers } = await auth.api.signInEmailOTP({
      body: { email, otp },
      returnHeaders: true,
    });
    return headers
      .getSetCookie()
      .map((value) => value.split(";")[0]!)
      .join("; ");
  };

  /**
   * What the WebAuthn ceremony leaves behind, which is all the two rules are allowed to read.
   * `offset` is from the session's own `created_at`, because that ordering is the whole rule.
   */
  const enrolPasskey = async (
    userId: string,
    sessionToken: string,
    offset: string,
  ): Promise<void> => {
    await pool.query(
      "INSERT INTO hf_passkey (id, name, public_key, user_id, credential_id, counter, " +
        "device_type, backed_up, created_at) VALUES ($1, 'device', 'pk', $2, $1, 0, " +
        "'singleDevice', true, (SELECT created_at FROM hf_session WHERE token = $3) + " +
        "$4::interval)",
      [`pk-${sessionToken.slice(0, 8)}`, userId, sessionToken, offset],
    );
  };

  const latestSessionToken = async (email: string): Promise<string> => {
    const { rows } = await pool.query<{ token: string }>(
      "SELECT token FROM hf_session WHERE user_id = (SELECT id FROM hf_user WHERE email = $1) " +
        "ORDER BY created_at DESC, id DESC LIMIT 1",
      [email],
    );
    return rows[0]!.token;
  };

  it("mounts every one of the four plugins", () => {
    // The endpoints are the proof the plugin is wired to a schema it can reach; a missing
    // table shows up as a missing model, not as a missing endpoint, which is why the
    // `hf_invitation` gap is documented at the call site instead.
    expect(typeof auth.api.signInEmailOTP).toBe("function");
    expect(typeof auth.api.generatePasskeyRegistrationOptions).toBe("function");
    expect(typeof auth.api.setRole).toBe("function");
    expect(typeof auth.api.createOrganization).toBe("function");
  });

  it("stamps a session signed in by emailed code as the code factor", async () => {
    const token = await signInByCode("member@app.test");

    const { rows } = await pool.query<{ factor: string; user_id: string }>(
      "SELECT factor, user_id FROM hf_session WHERE token = $1",
      [token],
    );
    expect(rows).toEqual([{ factor: "code", user_id: "u-member" }]);
  });

  it("signs nobody up: a code to an address with no hf_user row lets nobody in", async () => {
    // Requesting the code succeeds whoever asked — answering differently would turn the form
    // into a test for who has an account here. `disableSignUp` refuses at the redemption.
    await auth.api.sendVerificationOTP({
      body: { email: "stranger@app.test", type: "sign-in" },
    });
    const otp = sent.at(-1)?.otp ?? "000000";

    await expect(
      auth.api.signInEmailOTP({ body: { email: "stranger@app.test", otp } }),
    ).rejects.toBeInstanceOf(Error);

    const { rows } = await pool.query<{ users: number; sessions: number }>(
      "SELECT (SELECT count(*) FROM hf_user WHERE email = 'stranger@app.test')::int AS users, " +
        "(SELECT count(*) FROM hf_session)::int AS sessions",
    );
    expect(rows[0]).toEqual({ users: 0, sessions: 0 });
  });

  it("promotes the session that enrolled a passkey, and not one that merely asked", async () => {
    const token = await signInByCode("member@app.test");

    // The ceremony is client-side, so calling the promotion is not evidence it happened.
    expect(await upgradeSessionFactor(pool, token)).toBe(false);

    await enrolPasskey("u-member", token, "1 second");
    expect(await upgradeSessionFactor(pool, token)).toBe(true);
    const { rows } = await pool.query<{ factor: string }>(
      "SELECT factor FROM hf_session WHERE token = $1",
      [token],
    );
    expect(rows[0]!.factor).toBe("passkey");
  });

  it("lets a code session run the ceremony while the user has no passkey yet", async () => {
    const cookie = await signInWithCookie("member@app.test");

    await expect(
      auth.api.generatePasskeyRegistrationOptions({ headers: new Headers({ cookie }) }),
    ).resolves.toMatchObject({ rp: { id: "app.test" } });
  });

  it("404s the ceremony for a code session whose user already has a passkey", async () => {
    // The attacker who can read the inbox, on an account that is already enrolled. Without
    // this they would enrol their own authenticator and the promotion that follows would be
    // honest — which is why the refusal has to be here and not only on the promotion.
    const cookie = await signInWithCookie("member@app.test");
    await enrolPasskey("u-member", await latestSessionToken("member@app.test"), "-1 hour");

    await expect(
      auth.api.generatePasskeyRegistrationOptions({ headers: new Headers({ cookie }) }),
    ).rejects.toMatchObject({ status: "NOT_FOUND" });
  });
});
