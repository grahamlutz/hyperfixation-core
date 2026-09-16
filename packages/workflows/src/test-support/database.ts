import { randomBytes } from "node:crypto";
import { provisionRoles, type ProvisionedRoles } from "@hyperfixation/db/migrator";
import { Client } from "pg";

export const ADMIN_URL =
  process.env.HF_TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5434/postgres";

export interface TestDatabase {
  appName: string;
  databaseName: string;
  roles: ProvisionedRoles;
  migratorUrl: string;
  applicationUrl: string;
  drop(): Promise<void>;
}

/**
 * A fresh database plus its roles, torn down by `drop()` — the same hermetic shape
 * `@hyperfixation/db`'s own tests use. Repeated rather than imported because `db` publishes
 * its test support through neither entry of its `exports` map; chunk 8 is where it becomes
 * one shared helper in `@hyperfixation/testing`.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const appName = `test_${randomBytes(6).toString("hex")}`;
  const databaseName = `hf_${appName}`;

  await withAdmin(async (admin) => {
    await admin.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
  });

  const roles = await provisionRoles(ADMIN_URL, { appName, databaseName });

  const url = (role: string, password: string) => {
    const base = new URL(ADMIN_URL);
    base.pathname = `/${encodeURIComponent(databaseName)}`;
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

async function withAdmin(fn: (client: Client) => Promise<void>): Promise<void> {
  await asRole(ADMIN_URL, fn);
}
