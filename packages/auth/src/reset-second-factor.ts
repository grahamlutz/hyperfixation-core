import type { Pool } from "pg";
import { ADMIN_ROLE } from "./policy.js";
import type { RequireSession } from "./require-session.js";

/** One line per reset; the user has just lost every way in and support will be asked why. */
export const SECOND_FACTOR_RESET_MARKER = "hf-auth: second factor reset";

const DELETE_PASSKEYS_STATEMENT = "DELETE FROM hf_passkey WHERE user_id = $1 RETURNING id";

const DELETE_SESSIONS_STATEMENT = "DELETE FROM hf_session WHERE user_id = $1 RETURNING id";

const AUDIT_STATEMENT =
  "INSERT INTO hf_audit (actor_id, action, target_type, target_id, meta) " +
  "VALUES ($1, 'auth.second_factor_reset', 'user', $2, $3::jsonb)";

export interface ResetSecondFactorOptions {
  userId: string;
  /** The admin who did it. Null only for a reset driven from the CLI. */
  actorId?: string | null;
  reason?: string;
}

export interface ResetSecondFactorResult {
  userId: string;
  passkeysRemoved: number;
  sessionsRevoked: number;
}

/**
 * Unenrols every passkey a user holds, so someone who lost their device can be let back in
 * through the email code and enrol a new one.
 *
 * It revokes **all** of the user's sessions, not only the passkey-factor ones. A code-factor
 * session is confined to `/auth/*`, but `/auth/*` is exactly where enrolment lives: leaving one
 * alive would let whoever holds the lost device's still-valid session enrol a fresh
 * authenticator and promote itself back to `passkey`, which is the state this reset exists to
 * end. The passkey rows and the sessions go in one transaction for the same reason.
 */
export async function resetSecondFactor(
  pool: Pool,
  options: ResetSecondFactorOptions,
): Promise<ResetSecondFactorResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const passkeys = await client.query(DELETE_PASSKEYS_STATEMENT, [options.userId]);
    const sessions = await client.query(DELETE_SESSIONS_STATEMENT, [options.userId]);
    await client.query(AUDIT_STATEMENT, [
      options.actorId ?? null,
      options.userId,
      JSON.stringify({
        passkeysRemoved: passkeys.rowCount ?? 0,
        sessionsRevoked: sessions.rowCount ?? 0,
        reason: options.reason ?? null,
      }),
    ]);
    await client.query("COMMIT");

    const result: ResetSecondFactorResult = {
      userId: options.userId,
      passkeysRemoved: passkeys.rowCount ?? 0,
      sessionsRevoked: sessions.rowCount ?? 0,
    };
    console.info(SECOND_FACTOR_RESET_MARKER, JSON.stringify(result));
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export interface ResetSecondFactorActionOptions {
  pool: Pool;
  requireSession: RequireSession;
}

export type ResetSecondFactorAction = (
  options: ResetSecondFactorOptions,
) => Promise<ResetSecondFactorResult>;

/**
 * The admin action, with its guard attached rather than left to the caller to remember. It
 * takes the actor from the guarded session, so the audit row names who actually did it and not
 * whoever the form said.
 */
export function createResetSecondFactorAction(
  options: ResetSecondFactorActionOptions,
): ResetSecondFactorAction {
  return async (reset: ResetSecondFactorOptions): Promise<ResetSecondFactorResult> => {
    const session = await options.requireSession({ factor: "passkey", role: ADMIN_ROLE });
    return resetSecondFactor(options.pool, { ...reset, actorId: session.user.id });
  };
}
