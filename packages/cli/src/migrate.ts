import path from "node:path";
import { resolveApp, type ResolvedApp } from "./app.js";
import { requireEnv } from "./require-env.js";
import { credentialsOf, provisionLocalRoles, type LocalRoleResult } from "./roles.js";
import { run } from "./spawn.js";

/** The entrypoint track B's template ships; the same file the deployed `migrate` service runs. */
export const MIGRATE_ENTRY = "migrate.ts";

export interface MigrateAppOptions {
  dir?: string;
  /** Skips role provisioning — the cloud path, where `hf new` created the roles. */
  skipRoles?: boolean;
}

export interface MigrateAppResult {
  app: ResolvedApp;
  roles: LocalRoleResult | undefined;
}

/**
 * `hf migrate` — the application role, then the app's own migrator entrypoint.
 *
 * The second half is a child process running `migrate.ts` rather than a direct call to
 * `migrate()` from `@hyperfixation/db/migrator`, for one reason: the record tables and the app
 * migrations directory come from the app's registry, and `migrate.ts` is what reads them. It is
 * also the file the deployed one-shot `migrate` service runs, so `hf migrate` on a laptop and a
 * deploy cannot drift apart — which they would the moment the CLI grew its own argument list.
 *
 * The first half is the CLI's own, and only local: a container never creates a role.
 */
export async function migrateApp(options: MigrateAppOptions = {}): Promise<MigrateAppResult> {
  const app = await resolveApp(options.dir);
  const databaseUrl = requireEnv(app, "DATABASE_URL");
  const migratorUrl = requireEnv(app, "MIGRATOR_DATABASE_URL");

  let roles: LocalRoleResult | undefined;
  if (options.skipRoles !== true) {
    const credentials = credentialsOf(databaseUrl);
    roles = await provisionLocalRoles(migratorUrl, {
      databaseName: app.names.databaseName,
      applicationRole: credentials.user,
      applicationPassword: credentials.password,
    });
  }

  await run(process.execPath, ["--import", "tsx", path.join(app.dir, MIGRATE_ENTRY)], {
    cwd: app.dir,
    env: { ...app.env, HF_PROCESS: "migrate" },
  });

  return { app, roles };
}
