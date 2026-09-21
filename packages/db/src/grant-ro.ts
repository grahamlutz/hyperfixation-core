import type { Client } from "pg";
import { quoteIdent } from "./roles.js";

/**
 * Tables the read-only role is never granted. Metabase reaches the database
 * through this role, so anything that would let a reader mint or replay a staff
 * session — credentials, sessions, verification codes, passkeys, linked social
 * accounts — is excluded and actively revoked, not merely left ungranted.
 */
export const GRANT_RO_EXCLUDED_TABLES = [
  "hf_user",
  "hf_session",
  "hf_account",
  "hf_verification",
  "hf_passkey",
  // Session-derived: which session enrolled a passkey names a session, and the promotion reads it.
  "hf_session_passkey_enrolment",
] as const;

export interface GrantRoResult {
  /** False when the role does not exist: Metabase is optional per deployment. */
  applied: boolean;
  granted: string[];
  revoked: string[];
}

/**
 * Grants the read-only role `SELECT` on every table the migrator owns in
 * `public` except the auth set, and revokes everything on that set.
 *
 * Per-table rather than `ON ALL TABLES` because the exclusion cannot be
 * expressed as a default privilege, which is also why this is the migrator's
 * last step: it has to see the tables the deploy's migrations just created.
 */
export async function grantReadOnly(client: Client, readonlyRole: string): Promise<GrantRoResult> {
  const { rows: roleRows } = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [readonlyRole],
  );
  if (!roleRows[0]?.exists) return { applied: false, granted: [], revoked: [] };

  const role = quoteIdent(readonlyRole);
  const excluded = [...GRANT_RO_EXCLUDED_TABLES];

  const { rows } = await client.query<{ table_name: string; excluded: boolean }>(
    `SELECT c.relname AS table_name, (c.relname = ANY($1::text[])) AS excluded
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm')
        AND pg_get_userbyid(c.relowner) = current_user
      ORDER BY c.relname`,
    [excluded],
  );

  const granted: string[] = [];
  const revoked: string[] = [];
  for (const row of rows) {
    if (row.excluded) {
      await client.query(`REVOKE ALL ON ${quoteIdent(row.table_name)} FROM ${role}`);
      revoked.push(row.table_name);
    } else {
      await client.query(`GRANT SELECT ON ${quoteIdent(row.table_name)} TO ${role}`);
      granted.push(row.table_name);
    }
  }

  return { applied: true, granted, revoked };
}
