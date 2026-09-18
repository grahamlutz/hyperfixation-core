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
    const { rows } = await pool.query<{ token: string }>(
      "SELECT token FROM hf_session WHERE user_id = (SELECT id FROM hf_user WHERE email = $1)",
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

  it("promotes the session that enrolled a passkey, and only from code", async () => {
    const token = await signInByCode("member@app.test");

    expect(await upgradeSessionFactor(pool, token)).toBe(true);
    const factorOf = async (): Promise<string> => {
      const { rows } = await pool.query<{ factor: string }>(
        "SELECT factor FROM hf_session WHERE token = $1",
        [token],
      );
      return rows[0]!.factor;
    };
    expect(await factorOf()).toBe("passkey");

    // Already the stronger factor: a second call changes nothing and says so.
    expect(await upgradeSessionFactor(pool, token)).toBe(false);
    expect(await upgradeSessionFactor(pool, "no-such-token")).toBe(false);
  });
});
