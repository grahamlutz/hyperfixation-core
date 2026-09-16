import { randomBytes } from "node:crypto";
import {
  migrate,
  provisionRoles,
  type MigrateResult,
  type ProvisionedRoles,
  type RecordTable,
} from "@hyperfixation/db/migrator";
import { Client } from "pg";

/** The cluster every test database is created on; CI points this somewhere else. */
export const ADMIN_URL =
  process.env.HF_TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5434/postgres";

export interface CreateTestDatabaseOptions {
  adminUrl?: string;
  /** Tables registered with `defineRecord`; each gets a delete-guard trigger. */
  recordTables?: readonly RecordTable[];
  /** The app's own migrations directory, migrated after core's. */
  appMigrationsDir?: string;
}

export interface TestDatabase {
  appName: string;
  databaseName: string;
  roles: ProvisionedRoles;
  migratorUrl: string;
  applicationUrl: string;
  readonlyUrl: string;
  migration: MigrateResult;
  drop(): Promise<void>;
}

/**
 * A fresh `hf_test_<random>` database with its three roles and every migration applied,
 * torn down by `drop()`. Nothing is shared between two of these, so tests that take
 * cluster-wide locks or launch a worker can run in the same suite.
 */
export async function createTestDatabase(
  options: CreateTestDatabaseOptions = {},
): Promise<TestDatabase> {
  const adminUrl = options.adminUrl ?? ADMIN_URL;
  const appName = `test_${randomBytes(6).toString("hex")}`;
  const databaseName = `hf_${appName}`;

  await asRole(adminUrl, async (admin) => {
    await admin.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
  });

  const roles = await provisionRoles(adminUrl, {
    appName,
    databaseName,
    readonlyPassword: "ro-test-password",
  });

  const url = (role: string, password: string): string => {
    const base = new URL(adminUrl);
    base.pathname = `/${encodeURIComponent(databaseName)}`;
    base.username = role;
    base.password = password;
    return base.toString();
  };
  const migratorUrl = url(roles.migrator, roles.migratorPassword);

  const migration = await migrate(migratorUrl, {
    appName,
    recordTables: options.recordTables,
    appMigrationsDir: options.appMigrationsDir,
  });

  return {
    appName,
    databaseName,
    roles,
    migratorUrl,
    applicationUrl: url(roles.application, roles.applicationPassword),
    readonlyUrl: url(roles.readonly, roles.readonlyPassword ?? ""),
    migration,
    async drop() {
      await asRole(adminUrl, async (admin) => {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
        for (const role of [roles.migrator, roles.application, roles.readonly]) {
          await admin.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
        }
      });
    },
  };
}

/** Runs `fn` on a connection of its own as whatever role `connectionString` names. */
export async function asRole<T>(
  connectionString: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
