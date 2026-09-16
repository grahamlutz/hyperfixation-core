import { randomBytes } from "node:crypto";
import { Client } from "pg";

/** The identifier rule `hf new` validates an app name against. */
const APP_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export class RoleProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleProvisioningError";
  }
}

export interface RoleNames {
  /** Owns every `hf_*` object and the `dbos` schema; the only role `migrate` uses. */
  migrator: string;
  /** Used by `web` and `worker`; owns nothing. */
  application: string;
  /** Metabase's read-only role; created only when a password is supplied. */
  readonly: string;
}

export interface ProvisionRolesOptions {
  appName: string;
  databaseName: string;
  migratorPassword?: string;
  applicationPassword?: string;
  /** Supply to create the `_ro` role as well; omit to leave it uncreated. */
  readonlyPassword?: string;
}

export interface ProvisionedRoles extends RoleNames {
  migratorPassword: string;
  applicationPassword: string;
  readonlyPassword: string | undefined;
}

export function roleNames(appName: string): RoleNames {
  assertAppName(appName);
  return {
    migrator: `hf_${appName}_migrator`,
    application: `hf_${appName}`,
    readonly: `hf_${appName}_ro`,
  };
}

export function assertAppName(appName: string): void {
  if (!APP_NAME.test(appName)) {
    throw new RoleProvisioningError(
      `app name must match ${APP_NAME.source}, got ${JSON.stringify(appName)}`,
    );
  }
}

/**
 * Creates the migrator role, the application role, and optionally the read-only
 * role, and gives each the database- and schema-level privileges the migrator
 * cannot give itself later.
 *
 * The application role's privileges on `hf_*` tables come from default
 * privileges recorded here *for the migrator role*, not from a grant step in the
 * migrator: every deploy's migrations create tables as the migrator, so tables
 * added by a later deploy are granted at creation with no extra step to forget.
 * Privileges on `dbos.*` are a separate matter entirely — only
 * `dbos schema -r <role>` grants those (see `runDbosSchema`).
 *
 * `adminConnectionString` must be a superuser (or role-creating) connection; it
 * may point at any database on the cluster, since the target database is
 * reconnected to by name.
 */
export async function provisionRoles(
  adminConnectionString: string,
  options: ProvisionRolesOptions,
): Promise<ProvisionedRoles> {
  const names = roleNames(options.appName);
  assertIdentifier(options.databaseName, "database name");

  const provisioned: ProvisionedRoles = {
    ...names,
    migratorPassword: options.migratorPassword ?? generatePassword(),
    applicationPassword: options.applicationPassword ?? generatePassword(),
    readonlyPassword: options.readonlyPassword,
  };

  const admin = new Client({ connectionString: adminConnectionString });
  await admin.connect();
  try {
    await createLoginRole(admin, names.migrator, provisioned.migratorPassword, null);
    await createLoginRole(admin, names.application, provisioned.applicationPassword, 25);
    if (provisioned.readonlyPassword !== undefined) {
      await createLoginRole(admin, names.readonly, provisioned.readonlyPassword, 4);
    }

    const db = quoteIdent(options.databaseName);
    await admin.query(`GRANT CONNECT, CREATE ON DATABASE ${db} TO ${quoteIdent(names.migrator)}`);
    await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${quoteIdent(names.application)}`);
    if (provisioned.readonlyPassword !== undefined) {
      await admin.query(`GRANT CONNECT ON DATABASE ${db} TO ${quoteIdent(names.readonly)}`);
    }
  } finally {
    await admin.end();
  }

  const target = new Client({
    connectionString: withDatabase(adminConnectionString, options.databaseName),
  });
  await target.connect();
  try {
    await target.query(`GRANT CREATE, USAGE ON SCHEMA public TO ${quoteIdent(names.migrator)}`);
    await target.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(names.application)}`);
    await target.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(names.migrator)} IN SCHEMA public ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${quoteIdent(names.application)}`,
    );
    await target.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(names.migrator)} IN SCHEMA public ` +
        `GRANT USAGE, SELECT ON SEQUENCES TO ${quoteIdent(names.application)}`,
    );
    if (provisioned.readonlyPassword !== undefined) {
      await target.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdent(names.readonly)}`);
    }
  } finally {
    await target.end();
  }

  return provisioned;
}

async function createLoginRole(
  admin: Client,
  role: string,
  password: string,
  connectionLimit: number | null,
): Promise<void> {
  const { rows } = await admin.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [role],
  );
  const verb = rows[0]?.exists ? "ALTER" : "CREATE";
  const limit = connectionLimit === null ? "" : ` CONNECTION LIMIT ${connectionLimit}`;
  await admin.query(
    `${verb} ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)}${limit}`,
  );
}

export function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

/** Swaps the database of a connection string, keeping credentials and options. */
export function withDatabase(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${encodeURIComponent(databaseName)}`;
  return url.toString();
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function assertIdentifier(value: string, what: string): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value)) {
    throw new RoleProvisioningError(`${what} must be a plain identifier, got ${JSON.stringify(value)}`);
  }
}
