import { createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth, upgradeSessionFactor } from "./factory.js";

/**
 * The one thing these tests cannot supply is a real authenticator's attestation, so the WebAuthn
 * verifier is the single stubbed thing and everything else — the challenge cookie, the plugin's
 * handler, better-auth's dispatcher and both of `createAuth`'s hooks — is the real path. The
 * plugin is inlined in `vitest.config.ts` so this reaches *its* import.
 */
let verifyRegistration: () => unknown = () => ({ verified: false });

vi.mock("@simplewebauthn/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@simplewebauthn/server")>()),
  verifyRegistrationResponse: () => verifyRegistration(),
}));

/** What the verifier hands back for a ceremony that checked out. */
const attests = (credentialId: string) => () => ({
  verified: true,
  registrationInfo: {
    aaguid: "00000000-0000-0000-0000-000000000000",
    credentialDeviceType: "singleDevice",
    credentialBackedUp: true,
    credential: { id: credentialId, publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
  },
});

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
    verifyRegistration = () => ({ verified: false });
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
   * A code sign-in turned into the passkey factor, which is what `/passkey/verify-authentication`
   * stamps and what the WebAuthn ceremony cannot be driven to produce from a test.
   */
  const signInWithPasskeyCookie = async (email: string): Promise<string> => {
    const cookie = await signInWithCookie(email);
    await pool.query("UPDATE hf_session SET factor = 'passkey' WHERE token = $1", [
      await latestSessionToken(email),
    ]);
    return cookie;
  };

  /** The authenticator row a ceremony would leave behind, with no stamp on any session. */
  const enrolPasskey = async (id: string, userId: string): Promise<void> => {
    await pool.query(
      "INSERT INTO hf_passkey (id, name, public_key, user_id, credential_id, counter, " +
        "device_type, backed_up) VALUES ($1, 'device', 'pk', $2, $1, 0, 'singleDevice', true)",
      [id, userId],
    );
  };

  /** Both halves of the ceremony, carrying the challenge cookie between them as a browser would. */
  const runCeremony = async (cookie: string, credentialId: string): Promise<unknown> => {
    const options = await auth.api.generatePasskeyRegistrationOptions({
      headers: new Headers({ cookie }),
      returnHeaders: true,
    });
    const challenge = options.headers
      .getSetCookie()
      .map((value) => value.split(";")[0]!)
      .join("; ");

    return auth.api.verifyPasskeyRegistration({
      headers: new Headers({
        cookie: `${cookie}; ${challenge}`,
        origin: "https://app.test",
      }),
      body: {
        response: {
          id: credentialId,
          rawId: credentialId,
          type: "public-key",
          response: { transports: ["internal"] },
        },
      },
    });
  };

  const stampedTokens = async (): Promise<string[]> => {
    const { rows } = await pool.query<{ token: string }>(
      "SELECT token FROM hf_session WHERE passkey_enrolled_at IS NOT NULL ORDER BY token",
    );
    return rows.map((row) => row.token);
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

  it("promotes the session the ceremony stamped, and not one that merely asked", async () => {
    const cookie = await signInWithCookie("member@app.test");
    const token = await latestSessionToken("member@app.test");

    // The ceremony is client-side, so calling the promotion is not evidence it happened.
    expect(await upgradeSessionFactor(pool, token)).toBe(false);

    verifyRegistration = attests("cred-member");
    await expect(runCeremony(cookie, "cred-member")).resolves.toMatchObject({
      userId: "u-member",
    });

    expect(await stampedTokens()).toEqual([token]);
    expect(await upgradeSessionFactor(pool, token)).toBe(true);
    const { rows } = await pool.query<{ factor: string }>(
      "SELECT factor FROM hf_session WHERE token = $1",
      [token],
    );
    expect(rows[0]!.factor).toBe("passkey");
  });

  it("does not stamp a ceremony the verifier refused", async () => {
    // better-auth runs the after-hooks over a thrown `APIError` too, so without the success
    // check the stamp — and the promotion behind it — would be handed to anyone who can POST
    // the endpoint with junk. The default stub answers `verified: false`.
    const cookie = await signInWithCookie("member@app.test");
    const token = await latestSessionToken("member@app.test");

    await expect(runCeremony(cookie, "cred-junk")).rejects.toMatchObject({
      status: "BAD_REQUEST",
    });

    expect(await stampedTokens()).toEqual([]);
    expect(await upgradeSessionFactor(pool, token)).toBe(false);
  });

  it("does not stamp a registration with no challenge behind it", async () => {
    // The ceremony's second half on its own, which is what a direct POST looks like.
    const cookie = await signInWithCookie("member@app.test");
    const token = await latestSessionToken("member@app.test");

    await expect(
      auth.api.verifyPasskeyRegistration({
        headers: new Headers({ cookie, origin: "https://app.test" }),
        body: { response: { id: "junk", response: {} } },
      }),
    ).rejects.toMatchObject({ status: "BAD_REQUEST" });

    expect(await stampedTokens()).toEqual([]);
    expect(await upgradeSessionFactor(pool, token)).toBe(false);
  });

  it("stamps only the session that ran the ceremony", async () => {
    // BREAK 2. The victim holds an old authenticator and adds a second device from their own
    // passkey session; the attacker's inbox-only session has been sitting there the whole time
    // and must not come out of it holding the stronger factor.
    await enrolPasskey("pk-old", "u-member");
    const attacker = await signInWithCookie("member@app.test");
    const attackerToken = await latestSessionToken("member@app.test");
    const victim = await signInWithPasskeyCookie("member@app.test");
    const victimToken = await latestSessionToken("member@app.test");

    verifyRegistration = attests("cred-second-device");
    await runCeremony(victim, "cred-second-device");

    expect(await stampedTokens()).toEqual([victimToken]);
    expect(await upgradeSessionFactor(pool, attackerToken)).toBe(false);
    expect(attacker).not.toBe(victim);
  });

  it("refuses the whole of the adversary's chain from an inbox-only session", async () => {
    // Steps 1–6 as they were proved: code session, list the victim's passkey ids, delete them,
    // enrol your own, promote, hold `/admin/*`. It now stops at step 2.
    await enrolPasskey("pk-victim", "u-member");
    const cookie = await signInWithCookie("member@app.test");
    const token = await latestSessionToken("member@app.test");
    const headers = new Headers({ cookie });

    await expect(auth.api.listPasskeys({ headers })).rejects.toMatchObject({
      status: "NOT_FOUND",
    });
    await expect(
      auth.api.deletePasskey({ headers, body: { id: "pk-victim" } }),
    ).rejects.toMatchObject({ status: "NOT_FOUND" });
    verifyRegistration = attests("cred-attacker");
    await expect(runCeremony(cookie, "cred-attacker")).rejects.toMatchObject({
      status: "NOT_FOUND",
    });
    expect(await upgradeSessionFactor(pool, token)).toBe(false);

    const { rows } = await pool.query<{ ids: string[]; factor: string }>(
      "SELECT (SELECT array_agg(id ORDER BY id) FROM hf_passkey) AS ids, " +
        "(SELECT factor FROM hf_session WHERE token = $1) AS factor",
      [token],
    );
    expect(rows[0]).toEqual({ ids: ["pk-victim"], factor: "code" });
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
    await enrolPasskey("pk-member", "u-member");

    await expect(
      auth.api.generatePasskeyRegistrationOptions({ headers: new Headers({ cookie }) }),
    ).rejects.toMatchObject({ status: "NOT_FOUND" });
  });

  it("404s a code session every passkey endpoint that is not the ceremony", async () => {
    // BREAK 1, which is what made the gate above worth walking around: each of these asks for
    // a session and, on two of them, ownership — never a factor.
    const cookie = await signInWithCookie("member@app.test");
    await enrolPasskey("pk-member", "u-member");
    const headers = new Headers({ cookie });

    await expect(auth.api.listPasskeys({ headers })).rejects.toMatchObject({
      status: "NOT_FOUND",
    });
    await expect(
      auth.api.deletePasskey({ headers, body: { id: "pk-member" } }),
    ).rejects.toMatchObject({ status: "NOT_FOUND" });
    await expect(
      auth.api.updatePasskey({ headers, body: { id: "pk-member", name: "mine" } }),
    ).rejects.toMatchObject({ status: "NOT_FOUND" });

    // Step 3 of the chain refused, so the authenticator is still there and the gate still shut.
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM hf_passkey WHERE user_id = 'u-member'",
    );
    expect(rows[0]!.count).toBe(1);
  });

  it("404s a code session the management endpoints even with nothing enrolled", async () => {
    // The bootstrap opens the ceremony, not the rest of the plugin.
    const cookie = await signInWithCookie("member@app.test");

    await expect(auth.api.listPasskeys({ headers: new Headers({ cookie }) })).rejects.toMatchObject(
      { status: "NOT_FOUND" },
    );
  });

  it("lets a passkey session list, rename and delete its own authenticators", async () => {
    const cookie = await signInWithPasskeyCookie("member@app.test");
    await enrolPasskey("pk-member", "u-member");
    const headers = new Headers({ cookie });

    await expect(auth.api.listPasskeys({ headers })).resolves.toHaveLength(1);
    await expect(
      auth.api.updatePasskey({ headers, body: { id: "pk-member", name: "laptop" } }),
    ).resolves.toMatchObject({ passkey: { name: "laptop" } });
    await expect(auth.api.generatePasskeyRegistrationOptions({ headers })).resolves.toMatchObject({
      rp: { id: "app.test" },
    });
    await expect(
      auth.api.deletePasskey({ headers, body: { id: "pk-member" } }),
    ).resolves.toMatchObject({ status: true });
  });

  it("lets a passkey session enrol a second device and promotes nothing it need not", async () => {
    // demo-app's owner: already enrolled, signs in with the authenticator, adds a phone. The
    // session is already `passkey`, so the stamp changes nothing it depends on.
    await enrolPasskey("pk-laptop", "u-member");
    const cookie = await signInWithPasskeyCookie("member@app.test");
    const token = await latestSessionToken("member@app.test");

    verifyRegistration = attests("cred-phone");
    await expect(runCeremony(cookie, "cred-phone")).resolves.toMatchObject({
      userId: "u-member",
    });

    const { rows } = await pool.query<{ factor: string; count: number }>(
      "SELECT s.factor, (SELECT count(*)::int FROM hf_passkey) AS count " +
        "FROM hf_session s WHERE s.token = $1",
      [token],
    );
    expect(rows[0]).toEqual({ factor: "passkey", count: 2 });
  });

  it("leaves the passkey sign-in endpoints open to anyone, session or not", async () => {
    // They are how a passkey holder gets a session in the first place; a factor gate over them
    // would lock out the only people who hold the stronger factor.
    await expect(auth.api.generatePasskeyAuthenticationOptions({})).resolves.toMatchObject({
      rpId: "app.test",
    });
  });
});
