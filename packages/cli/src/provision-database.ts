import { randomBytes } from "node:crypto";
import { quoteIdent } from "@hyperfixation/db";
import { provisionRoles, roleNames, type RoleNames } from "@hyperfixation/db/migrator";
import { openDatabaseUrl, type Database } from "./database.js";
import { deriveNames } from "./names.js";
import type { AppStateStore } from "./state.js";

/** Created in the app's database before its first migration; both are `hf_*` table columns. */
export const REQUIRED_EXTENSIONS = ["vector", "pg_trgm"] as const;

export class ProvisionDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionDatabaseError";
  }
}

export interface ProvisionDatabaseOptions {
  /** The name `hf new` was given; `hf_<app>` and the three roles derive from it. */
  app: string;
  state: AppStateStore;
  /** Create the `_ro` role Metabase reads through. Default true. */
  readonlyRole?: boolean;
}

export interface ProvisionDatabaseResult {
  databaseName: string;
  roles: RoleNames;
  createdDatabase: boolean;
  /** Nothing was issued: the `database` step was already recorded. */
  alreadyDone: boolean;
  /**
   * A role that already existed was given a new password — a cold run against a live app.
   *
   * The deployed containers still hold the old one, so E3 has to order this
   * rotate → Coolify env → redeploy; a caller that ignores this locks the app out of its own
   * database until the next deploy.
   */
  rotated: boolean;
}

/**
 * The app's database, its extensions and its three roles, resumable and safe to rerun.
 *
 * Passwords live only in the state cache, and the order here is what keeps that honest: every
 * password is written to the file **after** the cluster has accepted it, never before. A crash
 * in between therefore leaves a state file that lags the database rather than one that leads
 * it, and the next run — which still sees the step unrecorded, and still has no password to
 * reuse — generates a fresh one and `ALTER`s again. Converging costs one more rotation; the
 * other order would leave a file whose passwords nothing can log in with, and those files are
 * the only copy there is.
 */
export async function provisionDatabase(
  target: Database | string,
  options: ProvisionDatabaseOptions,
): Promise<ProvisionDatabaseResult> {
  // `deriveNames` is `assertAppName`'s rule with hyphens allowed in the typed name only, so a
  // name carrying a quote, a semicolon or a `$(` is refused here rather than quoted downstream.
  const names = deriveNames(options.app);
  const roles = roleNames(names.appName);
  const { state } = options;

  const stored = state.state.database ?? {};
  if (
    state.isDone("database") &&
    stored.migratorPassword !== undefined &&
    stored.applicationPassword !== undefined
  ) {
    return {
      databaseName: names.databaseName,
      roles,
      createdDatabase: false,
      alreadyDone: true,
      rotated: false,
    };
  }

  const db = typeof target === "string" ? openDatabaseUrl(target) : target;
  const adminUrl = db.adminUrl();
  if (adminUrl === undefined) {
    throw new ProvisionDatabaseError(
      `roles cannot be provisioned over the ${db.kind} transport: provisionRoles() is a pg ` +
        "client and needs an address. Name the Postgres container — HF_DB_CONTAINER, or " +
        "HF_COOLIFY_POSTGRES_UUID — so the tunnel can discover one.",
    );
  }

  try {
    const createdDatabase = await createDatabaseIfAbsent(db, names.databaseName);
    for (const extension of REQUIRED_EXTENSIONS) {
      await db.query(`CREATE EXTENSION IF NOT EXISTS ${quoteIdent(extension)}`, {
        database: names.databaseName,
      });
    }

    const wanted = options.readonlyRole !== false;
    // A cold run is one with no password to reuse; it is a *rotation* only when the roles are
    // already there, which is the case that strands a deployed app on its old credentials.
    const regenerating =
      stored.migratorPassword === undefined || stored.applicationPassword === undefined;
    const rotated =
      regenerating && (await anyRoleExists(db, [roles.migrator, roles.application]));

    const provisioned = await provisionRoles(adminUrl, {
      appName: names.appName,
      databaseName: names.databaseName,
      migratorPassword: stored.migratorPassword,
      applicationPassword: stored.applicationPassword,
      readonlyPassword: wanted ? (stored.readonlyPassword ?? generatePassword()) : undefined,
    });

    await state.patch({
      database: {
        migratorPassword: provisioned.migratorPassword,
        applicationPassword: provisioned.applicationPassword,
        ...(provisioned.readonlyPassword === undefined
          ? {}
          : { readonlyPassword: provisioned.readonlyPassword }),
      },
    });
    await state.markDone("database");

    return { databaseName: names.databaseName, roles, createdDatabase, alreadyDone: false, rotated };
  } finally {
    if (typeof target === "string") await db.close();
  }
}

async function createDatabaseIfAbsent(db: Database, databaseName: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM pg_database WHERE datname = ${quoteLiteral(databaseName)}`,
  );
  if (rows.length > 0) return false;
  await db.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
  return true;
}

async function anyRoleExists(db: Database, roles: readonly string[]): Promise<boolean> {
  const list = roles.map(quoteLiteral).join(", ");
  const { rows } = await db.query(`SELECT 1 FROM pg_roles WHERE rolname IN (${list})`);
  return rows.length > 0;
}

/**
 * The `_ro` password. `provisionRoles` generates the other two itself, but creates the
 * read-only role only when it is handed one.
 */
function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
