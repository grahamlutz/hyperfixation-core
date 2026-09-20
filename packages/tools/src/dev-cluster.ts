import { Client } from "pg";

/**
 * The dev cluster every test provisions its own database on — the same default
 * `packages/testing/src/database.ts` resolves `ADMIN_URL` to, so `dev:doctor` and `dev:clean`
 * look at exactly the cluster the tests used.
 */
export const ADMIN_URL =
  process.env.HF_TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5434/postgres";

/** `createTestDatabase` names its database `hf_test_<random>`. */
export const TEST_PREFIX = "hf_test_";

/** The scratch-app convention: database `scratch_<name>`, roles `hf_<name>*`. */
export const SCRATCH_PREFIX = "scratch_";

/** `_` and `%` are LIKE wildcards, and both prefixes above contain a `_`. */
export function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export interface LeakedDatabase {
  name: string;
  /** Dropped with it; nothing else on the cluster can be using them. */
  roles: readonly string[];
}

/**
 * The three roles `provisionRoles` created alongside this database
 * (`hf_<app>_migrator`, `hf_<app>`, `hf_<app>_ro` — packages/db/src/roles.ts:37-43). A test
 * database is itself `hf_<app>`, so its name and its application role are the same string.
 */
export function rolesFor(databaseName: string): string[] {
  const app = databaseName.startsWith(SCRATCH_PREFIX)
    ? databaseName.slice(SCRATCH_PREFIX.length)
    : databaseName.replace(/^hf_/, "");
  return [`hf_${app}_migrator`, `hf_${app}`, `hf_${app}_ro`];
}

/**
 * Databases matching `prefix` that no backend is connected to — the ones whose `afterAll`
 * `drop()` a killed test process never reached. A database with a live backend is never
 * returned: that is the safety property `dev:clean` rests on, so the filter is SQL rather than
 * a post-hoc check.
 */
export async function leakedDatabases(client: Client, prefix: string): Promise<LeakedDatabase[]> {
  const { rows } = await client.query<{ datname: string }>(
    `SELECT d.datname
       FROM pg_database d
      WHERE d.datname LIKE $1
        AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)
      ORDER BY d.datname`,
    [likePrefix(prefix)],
  );
  return rows.map(({ datname }) => ({ name: datname, roles: rolesFor(datname) }));
}

/**
 * Drops the database and its roles. Plain `DROP DATABASE`, never `WITH (FORCE)`: a backend that
 * connected since `leakedDatabases` selected it should fail this drop, not be killed by it.
 */
export async function dropLeaked(client: Client, database: LeakedDatabase): Promise<void> {
  await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(database.name)}`);
  for (const role of database.roles) {
    await client.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
  }
}

export async function withAdmin<T>(
  fn: (client: Client) => Promise<T>,
  url = ADMIN_URL,
): Promise<T> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
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
