import { sessionFactors, type SessionFactor } from "@hyperfixation/db";

export type { SessionFactor };
export { sessionFactors };

/** The endpoint that proves possession of an enrolled authenticator. */
export const PASSKEY_AUTHENTICATION_PATH = "/passkey/verify-authentication";

/** Enrolment. It creates no session, but it does let an existing one be promoted. */
export const PASSKEY_REGISTRATION_PATH = "/passkey/verify-registration";

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
