import { randomBytes } from "node:crypto";
import { Client } from "pg";
import {
  provisionRoles,
  quoteIdent,
  withDatabase,
  type ProvisionedRoles,
} from "../roles.js";

export const ADMIN_URL =
  process.env.HF_TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5434/postgres";

export interface TestDatabase {
  appName: string;
  databaseName: string;
  roles: ProvisionedRoles;
  migratorUrl: string;
  applicationUrl: string;
  readonlyUrl: string;
  drop(): Promise<void>;
}

/** A fresh database plus its three roles, torn down by `drop()`. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const appName = `test_${randomBytes(6).toString("hex")}`;
  const databaseName = `hf_${appName}`;

  await withAdmin(async (admin) => {
    await admin.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
  });

  const roles = await provisionRoles(ADMIN_URL, {
    appName,
    databaseName,
    readonlyPassword: "ro-test-password",
  });

  const url = (role: string, password: string) => {
    const base = new URL(withDatabase(ADMIN_URL, databaseName));
    base.username = role;
    base.password = password;
    return base.toString();
  };

  return {
    appName,
    databaseName,
    roles,
    migratorUrl: url(roles.migrator, roles.migratorPassword),
    applicationUrl: url(roles.application, roles.applicationPassword),
    readonlyUrl: url(roles.readonly, roles.readonlyPassword ?? ""),
    async drop() {
      await withAdmin(async (admin) => {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
        for (const role of [roles.migrator, roles.application, roles.readonly]) {
          await admin.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
        }
      });
    },
  };
}

/** Runs `fn` on a connection as the role the test database was created by. */
export async function asRole<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withAdmin(fn: (client: Client) => Promise<void>): Promise<void> {
  await asRole(ADMIN_URL, fn);
}
