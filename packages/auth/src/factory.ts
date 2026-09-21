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
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin, emailOTP, organization } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { ADMIN_ROLE } from "./policy.js";
import {
  PASSKEY_REGISTRATION_PATHS,
  sessionFactorForPath,
  type SessionFactor,
} from "./session.js";

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
  "UPDATE hf_session SET factor = 'passkey', updated_at = now() " +
  "WHERE token = $1 AND factor = 'code' AND expires_at > now() " +
  "AND EXISTS (SELECT 1 FROM hf_passkey p " +
  "WHERE p.user_id = hf_session.user_id AND p.created_at >= hf_session.created_at)";

// Answers `mayEnrolPasskey`; see there for why a missing row is a yes.
const MAY_ENROL_PASSKEY_STATEMENT =
  "SELECT NOT EXISTS (SELECT 1 FROM hf_passkey p " +
  "WHERE p.user_id = s.user_id AND (p.created_at IS NULL OR p.created_at < s.created_at)) " +
  "AS may_enrol FROM hf_session s WHERE s.token = $1 AND s.factor = 'code'";

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
    hooks: {
      // The other half of `upgradeSessionFactor`'s rule, and it has to live here rather than in
      // `evaluateAccess`: `/api/auth/*` is the auth area, which a code session is allowed to
      // drive, and the plugin's own guard asks only for a session. 404 is what the policy
      // answers when a refusal must not describe what it refused.
      before: createAuthMiddleware(async (ctx) => {
        if (!PASSKEY_REGISTRATION_PATHS.includes(ctx.path)) return;
        const current = await getSessionFromCtx(ctx);
        if (current === null) return;
        if (!(await mayEnrolPasskey(options.pool, current.session.token))) {
          throw new APIError("NOT_FOUND");
        }
      }),
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
 * a deliberate second entry into `passkey`. What makes it safe is the `EXISTS` clause, not the
 * caller: the WebAuthn ceremony is client-side, so a server action that merely asks "is this a
 * code session?" before promoting is an invitation to skip the ceremony and call it directly —
 * whoever could read the emailed code would hold `passkey` and, with the role, `/admin/*`. The
 * proof of enrolment has to be a row, and it has to be one this session put there, so the
 * predicate is `hf_passkey.created_at >= hf_session.created_at`: a passkey the user already had
 * proves only that somebody once enrolled one, which is what the attacker is relying on.
 *
 * One statement, so there is no window between the read and the write: two concurrent calls
 * both see `factor = 'code'` only until the first commits, and the second updates no row.
 * `expires_at > now()` because a dead session is not one to hand the stronger factor to, and
 * the `factor = 'code'` predicate keeps it a no-op on a session that already holds it.
 */
export async function upgradeSessionFactor(pool: Pool, sessionToken: string): Promise<boolean> {
  const result = await pool.query(UPGRADE_SESSION_FACTOR_STATEMENT, [sessionToken]);
  return result.rowCount === 1;
}

/**
 * Whether this session may run the enrolment ceremony at all.
 *
 * The code factor is the bootstrap: a user with no passkey has nothing else to enrol their
 * first one with, and `/auth/passkey` exists for exactly that. It stops being a bootstrap the
 * moment the user has one — from then on an enrolment reached with only an emailed code is an
 * attacker adding *their* authenticator to the victim's account, which `upgradeSessionFactor`
 * would then promote legitimately. So a code session may enrol only while the user holds no
 * passkey older than the session; a passkey session may always add another.
 *
 * A `hf_passkey` row whose `created_at` is null counts as older, because the column is nullable
 * and the safe reading of "we cannot tell when this was enrolled" is "before you got here".
 * A token with no code-factor session row is not this check's business — better-auth's own
 * session middleware refuses an absent session, and a passkey session is allowed — so it is a
 * yes.
 */
export async function mayEnrolPasskey(pool: Pool, sessionToken: string): Promise<boolean> {
  const { rows } = await pool.query<{ may_enrol: boolean }>(MAY_ENROL_PASSKEY_STATEMENT, [
    sessionToken,
  ]);
  return rows[0]?.may_enrol ?? true;
}

/**
 * Inferred rather than declared as `ReturnType<typeof betterAuth>`: better-auth's `Auth` is
 * generic in the exact option object, so the widened form is not assignable to itself and the
 * plugins' endpoints disappear from `auth.api`.
 */
export type HyperfixationAuth = ReturnType<typeof createAuth>;

export type { SessionFactor };
