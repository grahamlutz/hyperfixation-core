import { sessionFactors, type SessionFactor } from "@hyperfixation/db";

export type { SessionFactor };
export { sessionFactors };

/** The endpoint that proves possession of an enrolled authenticator. */
export const PASSKEY_AUTHENTICATION_PATH = "/passkey/verify-authentication";

/** Enrolment. It creates no session, but it does let an existing one be promoted. */
export const PASSKEY_REGISTRATION_PATH = "/passkey/verify-registration";

/** The ceremony's first half. Gated with the second, or the refusal arrives too late to matter. */
export const PASSKEY_REGISTRATION_OPTIONS_PATH = "/passkey/generate-register-options";

/** Both halves of enrolment, as the paths better-auth dispatches on. */
export const PASSKEY_REGISTRATION_PATHS: readonly string[] = [
  PASSKEY_REGISTRATION_OPTIONS_PATH,
  PASSKEY_REGISTRATION_PATH,
];

/** The challenge half of the sign-in ceremony; named only so the open pair is spelled out. */
export const PASSKEY_AUTHENTICATION_OPTIONS_PATH = "/passkey/generate-authenticate-options";

/**
 * The only two `/passkey/*` endpoints that take no session, and so the only two the factor gate
 * has nothing to say about: they *are* how a passkey holder signs in.
 */
export const PASSKEY_SIGN_IN_PATHS: readonly string[] = [
  PASSKEY_AUTHENTICATION_OPTIONS_PATH,
  PASSKEY_AUTHENTICATION_PATH,
];

/**
 * An **allowlist by inversion**: every `/passkey/*` endpoint that is not one of the two sign-in
 * paths has to be answered for by factor, whether or not this file knows what it does.
 *
 * Naming the guarded paths instead was the first version's mistake. The plugin also exposes
 * `list-user-passkeys`, `delete-passkey` and `update-passkey`, each guarded on nothing but a
 * session and ownership, and a code session that can delete the victim's authenticators walks
 * straight back to "this user has no passkey, so let them enrol one" — the enrolment gate
 * undone by the endpoint next to it. A plugin upgrade that adds a fifth such endpoint must be
 * refused before anybody has read its release notes, which is what this shape buys.
 */
export function isGuardedPasskeyPath(path: string | null | undefined): boolean {
  if (typeof path !== "string" || !path.startsWith("/passkey/")) return false;
  return !PASSKEY_SIGN_IN_PATHS.includes(path);
}

/** The email-OTP sign-in endpoint, named here so the stamping rule reads as a pair. */
export const EMAIL_OTP_SIGN_IN_PATH = "/sign-in/email-otp";

/** What the guard needs of a user; better-auth's own user object is a superset. */
export interface SessionUser {
  id: string;
  email?: string;
  role?: string | null;
  banned?: boolean | null;
  /**
   * When the ban lapses. better-auth hands this back as a `Date` from the database and as an
   * ISO string once it has been through JSON, so both shapes have to read the same here.
   */
  banExpires?: Date | string | null;
}

/** What the guard needs of a session; better-auth's `session` is a superset. */
export interface AuthSession {
  factor: SessionFactor;
  user: SessionUser;
}

/**
 * An **allowlist**: only the passkey authentication endpoint mints a passkey-factor session,
 * and every other path — including one a future plugin adds — gets `code`. The column defaults
 * the same way for the same reason; a session must not reach a passkey-gated check because
 * nobody taught this function about the path that created it.
 */
export function sessionFactorForPath(path: string | null | undefined): SessionFactor {
  return path === PASSKEY_AUTHENTICATION_PATH ? "passkey" : "code";
}

/**
 * better-auth's admin plugin stores roles as one comma-separated `text` column, so membership
 * is a list test rather than an equality test. Comparison is case-insensitive because the role
 * arrives from whatever wrote the column — the bootstrap path, an admin UI, or a hand-run SQL.
 */
export function hasRole(user: SessionUser | null | undefined, role: string): boolean {
  if (!user?.role) return false;
  const wanted = role.trim().toLowerCase();
  return user.role
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .includes(wanted);
}
