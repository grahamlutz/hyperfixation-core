import {
  hfAccount,
  hfInvitation,
  hfMember,
  hfOrganization,
  hfPasskey,
  hfSession,
  hfUser,
  hfVerification,
} from "@hyperfixation/db";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, emailOTP, organization } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { ADMIN_ROLE } from "./policy.js";
import { sessionFactorForPath, type SessionFactor } from "./session.js";

/** Model name → the `hf_*` table it lives in. Every better-auth table is prefixed, forever. */
export const AUTH_SCHEMA = {
  user: hfUser,
  session: hfSession,
  account: hfAccount,
  verification: hfVerification,
  passkey: hfPasskey,
  organization: hfOrganization,
  member: hfMember,
  invitation: hfInvitation,
} as const;

/** Promotes a code-factor session in place; see `upgradeSessionFactor`. */
const UPGRADE_SESSION_FACTOR_STATEMENT =
  "UPDATE hf_session SET factor = 'passkey', updated_at = now() WHERE token = $1 AND factor = 'code'";

export interface CreateAuthOptions {
  /** The web pool — 5 connections in the budget. Never the step pool, never the control pool. */
  pool: Pool;
  /** `sendVerificationOTP` is the one thing this package cannot supply for an app. */
  sendVerificationOTP: Parameters<typeof emailOTP>[0]["sendVerificationOTP"];
  baseURL?: string;
  secret?: string;
  trustedOrigins?: string[];
  /** Relying-party id and name for WebAuthn; defaults come from `baseURL` in better-auth. */
  rpID?: string;
  rpName?: string;
  origin?: string | null;
}

/**
 * The better-auth instance, wired to the seven `hf_*` tables chunk 2 created.
 *
 * `disableSignUp: true` on the OTP plugin is the shape of the whole product: there is no
 * self-serve path into an app. A user exists because `bootstrapAdmin` or an existing admin put
 * them there, and a code sent to an address with no `hf_user` row signs nobody in.
 *
 * `emailAndPassword` is left off entirely rather than configured off — the `password` column on
 * `hf_account` is better-auth's, not a supported credential here — and the only two ways to
 * hold a session are an emailed code and a passkey, which is exactly what `factor` records.
 */
export function createAuth(options: CreateAuthOptions) {
  const db = drizzle(options.pool, { schema: AUTH_SCHEMA });

  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema: AUTH_SCHEMA }),
    baseURL: options.baseURL,
    secret: options.secret,
    trustedOrigins: options.trustedOrigins,
    session: {
      additionalFields: {
        // `input: false` — the factor is stamped from the endpoint that minted the session,
        // never from anything a client sends.
        factor: { type: "string", required: false, input: false, defaultValue: "code" },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => ({
            data: { ...session, factor: sessionFactorForPath(ctx?.path) },
          }),
        },
      },
    },
    plugins: [
      emailOTP({ sendVerificationOTP: options.sendVerificationOTP, disableSignUp: true }),
      passkey({ rpID: options.rpID, rpName: options.rpName, origin: options.origin }),
      admin({ defaultRole: "member", adminRoles: [ADMIN_ROLE] }),
      // `invitationLimit: 0` because an invitation ends in a sign-up, and there is no sign-up:
      // an invited stranger has nowhere to land. `hf_invitation` exists all the same — the
      // plugin refuses to initialise with a model it cannot reach — so turning invitations on
      // later is a config change, not a migration.
      organization({ invitationLimit: 0 }),
    ],
  });
}

/**
 * Promotes the session that just enrolled a passkey, so the user is not sent back through the
 * email code to reach the app they enrolled from.
 *
 * Registration is not authentication, so it does not go through `sessionFactorForPath`: this is
 * a deliberate second entry into `passkey`, taken only after `/passkey/verify-registration`
 * succeeded for this very session. It grants nothing an immediate passkey sign-in would not —
 * whoever enrolled the authenticator can use it — and the `factor = 'code'` predicate makes it
 * a no-op on a session that already holds the stronger factor.
 */
export async function upgradeSessionFactor(pool: Pool, sessionToken: string): Promise<boolean> {
  const result = await pool.query(UPGRADE_SESSION_FACTOR_STATEMENT, [sessionToken]);
  return result.rowCount === 1;
}

/**
 * Inferred rather than declared as `ReturnType<typeof betterAuth>`: better-auth's `Auth` is
 * generic in the exact option object, so the widened form is not assignable to itself and the
 * plugins' endpoints disappear from `auth.api`.
 */
export type HyperfixationAuth = ReturnType<typeof createAuth>;

export type { SessionFactor };
