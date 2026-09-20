import { quoteIdent } from "@hyperfixation/db";
import { Client } from "pg";

export interface LocalRoleOptions {
  databaseName: string;
  applicationRole: string;
  applicationPassword: string;
}

export interface LocalRoleResult {
  applicationRole: string;
  created: boolean;
}

/**
 * Creates the application role for a **local** app, on the migrator's own connection.
 *
 * `@hyperfixation/db`'s `provisionRoles` is the cloud path and is not usable here: it derives
 * both role names from the app name and records the application role's default privileges
 * `FOR ROLE hf_<app>_migrator`. Locally the migrator is the compose superuser `postgres` — that
 * is what track B's `.env.example` puts in `MIGRATOR_DATABASE_URL` — so privileges recorded for
 * a role that creates nothing would leave the application role unable to read the tables the
 * migrator just made. The grant here is recorded for whoever is connected, which is the role
 * that will own every `hf_*` object on this machine.
 *
 * The connection therefore has to be able to create a role, which the compose superuser can and
 * a deployed migrator role cannot — `hf migrate --skip-roles` is the cloud path, where `hf new`
 * created both roles before the first deploy.
 *
 * Idempotent: an existing role is re-`ALTER`ed to the password `.env` declares, and the grants
 * on already-existing objects are re-issued, so running it after the first `hf migrate` is a
 * no-op rather than a permissions gap.
 */
export async function provisionLocalRoles(
  migratorConnectionString: string,
  options: LocalRoleOptions,
): Promise<LocalRoleResult> {
  const role = quoteIdent(options.applicationRole);
  const client = new Client({ connectionString: migratorConnectionString });
  await client.connect();
  try {
    const { rows } = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
      [options.applicationRole],
    );
    const created = rows[0]?.exists !== true;
    await client.query(
      `${created ? "CREATE" : "ALTER"} ROLE ${role} LOGIN PASSWORD ` +
        `${quoteLiteral(options.applicationPassword)} CONNECTION LIMIT 25`,
    );

    await client.query(
      `GRANT CONNECT ON DATABASE ${quoteIdent(options.databaseName)} TO ${role}`,
    );
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
    );
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    );
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);

    return { applicationRole: options.applicationRole, created };
  } finally {
    await client.end();
  }
}

/** The role and password a `DATABASE_URL` carries — what the application role has to become. */
export function credentialsOf(connectionString: string): { user: string; password: string } {
  const url = new URL(connectionString);
  return { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}

export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
