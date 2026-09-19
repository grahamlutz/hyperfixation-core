import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ADMIN_ROLE } from "./policy.js";

/** The designated address, when the deploy names one instead of relying on "first user". */
export const BOOTSTRAP_EMAIL_ENV = "HF_BOOTSTRAP_EMAIL";

/** One line when an app gets its first admin; it should happen exactly once per app. */
export const BOOTSTRAPPED_MARKER = "hf-auth: bootstrapped";

/**
 * Serialises the whole check-then-write against another `hf bootstrap` running at the same
 * time. The counts this reads are otherwise unlocked, so "no admin exists yet" would be true in
 * two transactions at once and both would grant.
 */
const BOOTSTRAP_LOCK_STATEMENT = "SELECT pg_advisory_xact_lock(hashtext('hf-auth:bootstrap'))";

/** `hasRole(user, 'admin')` in SQL: the column is one comma-separated list, not one role. */
const ADMIN_EXISTS_STATEMENT =
  "SELECT id, email FROM hf_user WHERE role IS NOT NULL AND lower(role) ~ '(^|,)\\s*admin\\s*($|,)' LIMIT 1";

const USER_COUNT_STATEMENT = "SELECT count(*)::int AS count FROM hf_user";

const USER_BY_EMAIL_STATEMENT = "SELECT id, role FROM hf_user WHERE lower(email) = lower($1)";

const INSERT_USER_STATEMENT =
  "INSERT INTO hf_user (id, name, email, email_verified, role) VALUES ($1, $2, $3, false, $4)";

const GRANT_ROLE_STATEMENT = "UPDATE hf_user SET role = $2, updated_at = now() WHERE id = $1";

const AUDIT_STATEMENT =
  "INSERT INTO hf_audit (actor_id, action, target_type, target_id, meta) " +
  "VALUES (NULL, 'auth.bootstrapped', 'user', $1, $2::jsonb)";

export type BootstrapRefusal =
  | "admin-exists"
  | "not-designated"
  | "not-first-user"
  | "no-designation";

/** Refusals are by reason, because the CLI prints the reason and each has a different fix. */
export class BootstrapRefused extends Error {
  readonly reason: BootstrapRefusal;

  constructor(reason: BootstrapRefusal, message: string) {
    super(message);
    this.name = "BootstrapRefused";
    this.reason = reason;
  }
}

export interface BootstrapAdminOptions {
  /**
   * The address to bootstrap. Defaults to the designation in force — `designatedEmail`, else
   * `HF_BOOTSTRAP_EMAIL` — so a deploy that names its owner need not name it twice. Neither is
   * a `no-designation` refusal, not a crash.
   */
  email?: string;
  name?: string;
  /**
   * Overrides `HF_BOOTSTRAP_EMAIL`. Pass `null` to run the first-user branch with the
   * environment ignored.
   */
  designatedEmail?: string | null;
}

export interface BootstrapResult {
  userId: string;
  email: string;
  /** False when the row already existed and only the role was granted. */
  created: boolean;
}

/**
 * The one way an app gets its first admin, and the answer to the chicken-and-egg: granting
 * `admin` needs an admin, so this runs **outside the request path entirely** — `hf bootstrap`,
 * on the box, against the database. It is not an endpoint, it is not reachable from the
 * better-auth handler, and there is no self-serve path to it; `disableSignUp: true` means there
 * is no self-serve path to a user at all.
 *
 * Its "one-time" is enforced, not documented: it refuses the moment any user holds `admin`,
 * so a second run on a live app is a refusal rather than a second grant. After that, admins are
 * made by admins.
 *
 * Two branches, both narrow. With `HF_BOOTSTRAP_EMAIL` set, only that address may be
 * bootstrapped — a deploy designating its owner. With it unset, only the first user of an empty
 * `hf_user` may be. Unset **and** a populated table is refused rather than guessed at: that is
 * the state where "the first user" has no meaning and picking one would be inventing an admin.
 */
export async function bootstrapAdmin(
  pool: Pool,
  options: BootstrapAdminOptions,
): Promise<BootstrapResult> {
  const designated =
    options.designatedEmail === undefined
      ? (process.env[BOOTSTRAP_EMAIL_ENV] ?? null)
      : options.designatedEmail;
  const email = trimmed(options.email) ?? trimmed(designated);
  if (email === undefined) {
    throw new BootstrapRefused(
      "no-designation",
      `no address to bootstrap: pass an email or set ${BOOTSTRAP_EMAIL_ENV}`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(BOOTSTRAP_LOCK_STATEMENT);
    const result = await bootstrap(client, email, options.name ?? email, designated);
    await client.query("COMMIT");
    console.info(BOOTSTRAPPED_MARKER, JSON.stringify(result));
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function trimmed(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text === "" ? undefined : text;
}

async function bootstrap(
  client: PoolClient,
  email: string,
  name: string,
  designated: string | null,
): Promise<BootstrapResult> {
  const existingAdmin = await client.query<{ id: string; email: string }>(ADMIN_EXISTS_STATEMENT);
  if (existingAdmin.rows.length > 0) {
    throw new BootstrapRefused(
      "admin-exists",
      `${existingAdmin.rows[0]!.email} is already an admin; grant the role from the admin area instead`,
    );
  }

  const user = await client.query<{ id: string; role: string | null }>(USER_BY_EMAIL_STATEMENT, [
    email,
  ]);

  if (designated !== null) {
    if (designated.trim().toLowerCase() !== email.toLowerCase()) {
      throw new BootstrapRefused(
        "not-designated",
        `${BOOTSTRAP_EMAIL_ENV} designates ${designated.trim()}, not ${email}`,
      );
    }
  } else {
    const { rows } = await client.query<{ count: number }>(USER_COUNT_STATEMENT);
    const users = rows[0]!.count;
    if (users > 0 && user.rows.length === 0) {
      throw new BootstrapRefused(
        "not-first-user",
        `${users} user(s) already exist and none is an admin; set ${BOOTSTRAP_EMAIL_ENV} to name the one to promote`,
      );
    }
  }

  const existing = user.rows[0];
  const userId = existing?.id ?? randomUUID();
  if (existing === undefined) {
    await client.query(INSERT_USER_STATEMENT, [userId, name, email, ADMIN_ROLE]);
  } else {
    await client.query(GRANT_ROLE_STATEMENT, [userId, ADMIN_ROLE]);
  }

  const result: BootstrapResult = { userId, email, created: existing === undefined };
  await client.query(AUDIT_STATEMENT, [
    userId,
    JSON.stringify({ email, created: result.created, designated: designated !== null }),
  ]);
  return result;
}
