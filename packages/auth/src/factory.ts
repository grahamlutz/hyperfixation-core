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
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { admin, emailOTP, organization } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { ADMIN_ROLE } from "./policy.js";
import {
  isGuardedPasskeyPath,
  PASSKEY_REGISTRATION_PATH,
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
  "AND EXISTS (SELECT 1 FROM hf_session_passkey_enrolment e WHERE e.session_id = hf_session.id) " +
  "AND EXISTS (SELECT 1 FROM hf_passkey p WHERE p.user_id = hf_session.user_id)";

/** Records that this very session completed a registration; see `stampPasskeyEnrolment`. */
const STAMP_PASSKEY_ENROLMENT_STATEMENT =
  "INSERT INTO hf_session_passkey_enrolment (session_id) " +
  "SELECT id FROM hf_session WHERE token = $1 ON CONFLICT (session_id) DO NOTHING";

// Answers `passkeyEndpointAllowed`. A session's own factor and whether its user holds any
// authenticator at all — no timestamps, because a time is not a session.
const PASSKEY_SESSION_STATEMENT =
  "SELECT s.factor, EXISTS (SELECT 1 FROM hf_passkey p WHERE p.user_id = s.user_id) " +
  "AS has_passkey FROM hf_session s WHERE s.token = $1";

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
      // `evaluateAccess`: `routeAreaOf` strips `/api`, so `/api/auth/passkey/*` is the auth
      // area, which a code session is allowed to drive, and the plugin's own guards ask for a
      // session and (on three of them) ownership, never a factor. 404 is what the policy
      // answers when a refusal must not describe what it refused.
      before: createAuthMiddleware(async (ctx) => {
        if (!isGuardedPasskeyPath(ctx.path)) return;
        const current = await getSessionFromCtx(ctx);
        // No session is the plugin's own refusal to make, not this gate's.
        if (current === null) return;
        if (!(await passkeyEndpointAllowed(options.pool, current.session.token, ctx.path))) {
          throw new APIError("NOT_FOUND");
        }
      }),
      // What a promotion is later allowed to read. It has to be here and not in the template's
      // server action for the same reason the predicate cannot be `factor = 'code'`: only
      // better-auth knows whether the ceremony actually verified.
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== PASSKEY_REGISTRATION_PATH) return;
        if (!passkeyRegistrationSucceeded(ctx.context.returned)) return;
        // The before hook already resolved this and `getSessionFromCtx` caches on the context,
        // so this is the *calling* session even when the endpoint minted a second one.
        const current = await getSessionFromCtx(ctx);
        if (current === null) return;
        await stampPasskeyEnrolment(options.pool, current.session.token);
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
 * Registration is not authentication, so it does not go through `sessionFactorForPath`: this is a
 * deliberate second entry into `passkey`. What makes it safe is the `hf_session_passkey_enrolment`
 * row, not the caller: the WebAuthn ceremony is client-side, so a server action that merely asks
 * "is this a code session?" before promoting is an invitation to skip the ceremony and call it
 * directly — whoever could read the emailed code would hold `passkey` and, with the role,
 * `/admin/*`.
 *
 * The proof has to name *this session*, and it is written by `createAuth`'s after-hook when the
 * plugin itself returned a verified registration. Anything that infers enrolment from a time —
 * "a `hf_passkey` row newer than this session exists" was the first attempt — binds the
 * promotion to a clock rather than to a session: an attacker's idle code session promotes itself
 * the moment the victim legitimately adds a second device from their own passkey session, hours
 * later and with nothing of the attacker's involved.
 *
 * One statement, so there is no window between the read and the write: two concurrent calls
 * both see `factor = 'code'` only until the first commits, and the second updates no row.
 * `expires_at > now()` because a dead session is not one to hand the stronger factor to, and
 * the `factor = 'code'` predicate keeps it a no-op on a session that already holds it. The
 * `EXISTS` on `hf_passkey` is belt and braces — a stamp with no surviving authenticator behind
 * it is nothing to promote on — and both `EXISTS` clauses are time-free, so neither can refuse
 * an honest enrolment.
 */
export async function upgradeSessionFactor(pool: Pool, sessionToken: string): Promise<boolean> {
  const result = await pool.query(UPGRADE_SESSION_FACTOR_STATEMENT, [sessionToken]);
  return result.rowCount === 1;
}

/**
 * Records on the calling session that it, and not some other session of the same user, completed
 * a passkey registration. The one thing `upgradeSessionFactor` promotes on.
 *
 * `SELECT id FROM hf_session WHERE token = $1` rather than a parameter, so a token that names no
 * session inserts nothing and there is no row to orphan. Unconditional on `factor`: stamping a
 * session that already holds `passkey` is inert. True means a row was written, so a second stamp
 * of the same session is false — the `ON CONFLICT` makes the first one stand. It is the caller —
 * `createAuth`'s after-hook — that must have established the registration actually succeeded,
 * because nothing in this statement can tell.
 */
export async function stampPasskeyEnrolment(pool: Pool, sessionToken: string): Promise<boolean> {
  const result = await pool.query(STAMP_PASSKEY_ENROLMENT_STATEMENT, [sessionToken]);
  return result.rowCount === 1;
}

/**
 * Whether `/passkey/verify-registration` returned a registration rather than a refusal.
 *
 * better-auth's dispatcher runs the after-hooks either way: an `APIError` thrown by the handler
 * is caught and parked in `ctx.context.returned` before they run, so a failed ceremony reaches
 * this hook looking exactly like a successful one but for the value. A stamp on a failure would
 * hand the promotion to anyone who can POST the endpoint with junk.
 */
export function passkeyRegistrationSucceeded(returned: unknown): boolean {
  if (returned === null || typeof returned !== "object") return false;
  if (isAPIError(returned)) return false;
  // The endpoint answers with the created `hf_passkey` row, so its id is the proof.
  return typeof (returned as { id?: unknown }).id === "string";
}

/**
 * Which `/passkey/*` endpoint this session's factor may drive at all.
 *
 * A `passkey` session may drive every one of them — it proved possession of an authenticator,
 * which is the whole of what the plugin's own guards assume. A `code` session may reach only the
 * two registration paths, and only while its user holds **no** authenticator: the emailed code
 * is the bootstrap for a *first* passkey and `/auth/passkey` exists for exactly that, and it
 * stops being a bootstrap the moment there is one to be locked out of.
 *
 * "No passkey" is counted over the whole user with no reference to when anything was created.
 * A code session must not reach `delete-passkey` either, because the two rules compose into the
 * attack otherwise: delete the victim's authenticators, become a first enrolment again, enrol
 * your own. Hence the caller is `isGuardedPasskeyPath`, not a list of the paths known to be
 * dangerous.
 *
 * A token with no `hf_session` row is not this check's business — better-auth's own session
 * middleware refuses an absent session — so it is a yes.
 */
export async function passkeyEndpointAllowed(
  pool: Pool,
  sessionToken: string,
  path: string,
): Promise<boolean> {
  const { rows } = await pool.query<{ factor: string; has_passkey: boolean }>(
    PASSKEY_SESSION_STATEMENT,
    [sessionToken],
  );
  const session = rows[0];
  if (session === undefined) return true;
  if (session.factor !== "code") return true;
  return PASSKEY_REGISTRATION_PATHS.includes(path) && !session.has_passkey;
}

/**
 * Whether this session may run the enrolment ceremony: `passkeyEndpointAllowed` asked about the
 * registration path. Kept as its own name because that is the question the template's enrolment
 * page and the recovery path are about.
 */
export async function mayEnrolPasskey(pool: Pool, sessionToken: string): Promise<boolean> {
  return passkeyEndpointAllowed(pool, sessionToken, PASSKEY_REGISTRATION_PATH);
}

/**
 * Inferred rather than declared as `ReturnType<typeof betterAuth>`: better-auth's `Auth` is
 * generic in the exact option object, so the widened form is not assignable to itself and the
 * plugins' endpoints disappear from `auth.api`.
 */
export type HyperfixationAuth = ReturnType<typeof createAuth>;

export type { SessionFactor };
