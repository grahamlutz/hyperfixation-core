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
        await waitForDrain(admin, databaseName);
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
        for (const role of [roles.migrator, roles.application, roles.readonly]) {
          await admin.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
        }
      });
    },
  };
}

/** How long `drop()` gives the database's own backends to go away before forcing them out. */
const DRAIN_TIMEOUT_MS = 5_000;
const DRAIN_POLL_MS = 10;

/**
 * Waits until nothing is connected to `databaseName`, so the drop that follows finds no backend
 * to terminate.
 *
 * Awaiting every `pool.end()` in an `afterAll` is not that guarantee: `pg`'s `pool.end()` resolves
 * as soon as it has *called* `client.end()` on each pooled connection, not when their sockets have
 * closed — `pg-pool`'s `_remove` drops the client from its bookkeeping and fires the end callback
 * without waiting. `WITH (FORCE)` then terminates whatever is still winding down, and a `pg`
 * client killed mid-`end()` still carries the pool's `idleListener`, which re-emits the `57P01` on
 * a pool nothing is listening to — an uncaught exception that fails the task after every test in
 * it has passed.
 *
 * Bounded rather than unbounded: a connection that is genuinely leaked rather than closing should
 * still be forced out and the suite torn down, not hang here.
 */
async function waitForDrain(admin: Client, databaseName: string): Promise<void> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  for (;;) {
    const { rows } = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1",
      [databaseName],
    );
    if (rows[0]!.n === 0 || Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
  }
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
