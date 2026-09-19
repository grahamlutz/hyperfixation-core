import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { checkE005 } from "./boot-checks.js";
import { installDeleteGuards, type DeleteGuardResult, type RecordTable } from "./delete-guard.js";
import { grantReadOnly, type GrantRoResult } from "./grant-ro.js";
import { roleNames } from "./roles.js";

const execFileAsync = promisify(execFile);

export const CORE_MIGRATIONS_TABLE = "hf_core_migrations";
export const CORE_MIGRATIONS_SCHEMA = "drizzle";
export const DBOS_SCHEMA = "dbos";

export const CORE_MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export class MigratorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigratorError";
  }
}

export interface MigrateOptions {
  appName: string;
  /** Defaults to `hf_<appName>`; this is the role `dbos schema -r` grants. */
  applicationRole?: string;
  /** Defaults to `hf_<appName>_ro`; skipped when the role does not exist. */
  readonlyRole?: string;
  coreMigrationsDir?: string;
  appMigrationsDir?: string;
  /** Tables registered with `defineRecord`; each gets a delete-guard trigger. */
  recordTables?: readonly RecordTable[];
  /**
   * Runs step 3 as `dbos schema -s dbos` with no `-r`. Exists only so a test can
   * reproduce the deployment mistake E006 catches: the system schema is created
   * and the application role is granted nothing on it. A real deploy that sets
   * this produces a worker that cannot launch — the name is loud on purpose.
   */
  dangerouslySkipApplicationRoleGrant?: boolean;
}

export interface MigrateResult {
  applicationRole: string;
  dbosSchemaGranted: boolean;
  appMigrationsApplied: boolean;
  deleteGuards: DeleteGuardResult;
  grantRo: GrantRoResult;
}

/**
 * The five-step migrator, run as the migrator role on every deploy:
 * core migrations, app migrations, `dbos schema -s dbos -r hf_<app>`,
 * delete-guard triggers, `hf_grant_ro`.
 *
 * Order is load-bearing at both ends. Step 3 runs on every deploy, not just the
 * first, so an SDK upgrade that adds a system table grants it before the worker
 * that needs it starts; steps 4 and 5 run last because both have to see the
 * tables steps 1 and 2 just created.
 */
export async function migrate(
  migratorConnectionString: string,
  options: MigrateOptions,
): Promise<MigrateResult> {
  const names = roleNames(options.appName);
  const applicationRole = options.applicationRole ?? names.application;
  const readonlyRole = options.readonlyRole ?? names.readonly;
  const coreMigrationsDir = options.coreMigrationsDir ?? CORE_MIGRATIONS_DIR;

  const client = new Client({ connectionString: migratorConnectionString });
  await client.connect();
  try {
    await assertProvisioned(client, options.appName, applicationRole);

    const db = drizzle(client);

    await drizzleMigrate(db, {
      migrationsFolder: coreMigrationsDir,
      migrationsTable: CORE_MIGRATIONS_TABLE,
      migrationsSchema: CORE_MIGRATIONS_SCHEMA,
    });

    if (options.appMigrationsDir !== undefined) {
      // E005 runs here as well as at boot: refusing the migration is the only
      // point at which an app's attempt to reshape an hf_* table is still undone.
      await checkE005(options.appMigrationsDir);
      await drizzleMigrate(db, { migrationsFolder: options.appMigrationsDir });
    }

    const grantTo = options.dangerouslySkipApplicationRoleGrant === true ? null : applicationRole;
    await runDbosSchema(migratorConnectionString, grantTo);

    const deleteGuards = await installDeleteGuards(client, options.recordTables ?? []);
    const grantRo = await grantReadOnly(client, readonlyRole);

    return {
      applicationRole,
      dbosSchemaGranted: grantTo !== null,
      appMigrationsApplied: options.appMigrationsDir !== undefined,
      deleteGuards,
      grantRo,
    };
  } finally {
    await client.end();
  }
}

const PROVISION_STATEMENT = `
  SELECT current_user AS connected_role,
         current_database() AS database_name,
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS application_role_exists,
         has_database_privilege(current_user, current_database(), 'CREATE') AS create_on_database,
         coalesce(
           has_schema_privilege(current_user, to_regnamespace('public'), 'CREATE'),
           false
         ) AS create_on_public`;

/**
 * The state `provisionRoles` leaves behind and the migrator cannot create for itself: a role
 * cannot grant itself `CREATE`, and granting `dbos` to an application role that does not exist
 * is not something a migration can fix. Each of these otherwise surfaces one at a time, several
 * steps apart — the `CREATE SCHEMA "drizzle"` of step 1, then `public`, then step 3's `-r` —
 * so a plain `CREATE DATABASE` costs three runs to discover what one message can say.
 */
async function assertProvisioned(
  client: Client,
  appName: string,
  applicationRole: string,
): Promise<void> {
  const { rows } = await client.query<{
    connected_role: string;
    database_name: string;
    application_role_exists: boolean;
    create_on_database: boolean;
    create_on_public: boolean;
  }>(PROVISION_STATEMENT, [applicationRole]);
  const state = rows[0]!;

  const missing: string[] = [];
  if (!state.application_role_exists) {
    missing.push(`the application role "${applicationRole}" does not exist`);
  }
  if (!state.create_on_database) {
    missing.push(`"${state.connected_role}" may not CREATE in database "${state.database_name}"`);
  }
  if (!state.create_on_public) {
    missing.push(`"${state.connected_role}" may not CREATE in schema "public"`);
  }
  if (missing.length === 0) return;

  throw new MigratorError(
    `database "${state.database_name}" is not provisioned for ${appName}: ${missing.join("; ")}. ` +
      "Run `hf migrate` in the app directory, which provisions the roles before running this; " +
      "a deployed database is provisioned by provisionRoles() from @hyperfixation/db/migrator.",
  );
}

/**
 * `dbos schema -s dbos -r <role>`: creates the DBOS system schema and grants the
 * application role on it. The `-r` flag is the only path to those grants — the
 * SDK's `getDbosSchemaPermissionsSql` is the sole source of `GRANT` statements
 * anywhere in it — and without them the worker cannot launch at all.
 */
export async function runDbosSchema(
  migratorConnectionString: string,
  applicationRole: string | null,
  schema: string = DBOS_SCHEMA,
): Promise<void> {
  const cli = resolveDbosCli();
  const args = [cli, "schema", "-s", schema];
  if (applicationRole !== null) args.push("-r", applicationRole);
  args.push(migratorConnectionString);
  try {
    await execFileAsync(process.execPath, args, { encoding: "utf8" });
  } catch (cause) {
    throw new MigratorError(
      `dbos schema -s ${schema}${applicationRole === null ? "" : ` -r ${applicationRole}`} failed: ` +
        (cause as Error).message,
      { cause },
    );
  }
}

function resolveDbosCli(): string {
  const require = createRequire(import.meta.url);
  let dir = path.dirname(require.resolve("@dbos-inc/dbos-sdk"));
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
        bin?: Record<string, string>;
      };
      if (pkg.name === "@dbos-inc/dbos-sdk" && pkg.bin?.dbos !== undefined) {
        return path.resolve(dir, pkg.bin.dbos);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new MigratorError("could not locate the @dbos-inc/dbos-sdk CLI");
    dir = parent;
  }
}
