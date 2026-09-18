import { ADMIN_URL, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { credentialsOf, provisionLocalRoles } from "./roles.js";

describe("credentialsOf", () => {
  it("takes the role and password out of a DATABASE_URL, percent-decoded", () => {
    expect(credentialsOf("postgres://hf_demo_app:p%40ss@localhost:5432/hf_demo_app")).toEqual({
      user: "hf_demo_app",
      password: "p@ss",
    });
  });
});

describe("provisionLocalRoles", () => {
  let db: TestDatabase;
  /**
   * The superuser, not `db.migratorUrl`. That is the shape of a local app: track B's
   * `.env.example` puts the compose superuser in `MIGRATOR_DATABASE_URL`, and creating a role
   * is the one thing this command does that an ordinary migrator role cannot.
   */
  let superuserUrl: string;
  const role = "hf_cli_local_test";
  const password = "cli-local-test";

  beforeAll(async () => {
    db = await createTestDatabase();
    const url = new URL(ADMIN_URL);
    url.pathname = `/${encodeURIComponent(db.databaseName)}`;
    superuserUrl = url.toString();
  }, 90_000);

  afterAll(async () => {
    if (db === undefined) return;
    const client = new Client({ connectionString: superuserUrl });
    await client.connect();
    await client.query(`DROP OWNED BY ${JSON.stringify(role)}`).catch(() => undefined);
    await client.query(`DROP ROLE IF EXISTS ${JSON.stringify(role)}`).catch(() => undefined);
    await client.end();
    await db.drop();
  });

  it("creates a role that can read the tables the migrator already made", async () => {
    const result = await provisionLocalRoles(superuserUrl, {
      databaseName: db.databaseName,
      applicationRole: role,
      applicationPassword: password,
    });
    expect(result.created).toBe(true);

    const url = new URL(superuserUrl);
    url.username = role;
    url.password = password;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      // The grant on already-existing objects, which default privileges alone would not cover:
      // locally the role is created after the first `hf migrate` as often as before it.
      const { rows } = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM hf_run",
      );
      expect(rows[0]?.count).toBe(0);
    } finally {
      await client.end();
    }
  }, 30_000);

  it("is idempotent: a second pass alters the existing role instead of failing", async () => {
    const result = await provisionLocalRoles(superuserUrl, {
      databaseName: db.databaseName,
      applicationRole: role,
      applicationPassword: password,
    });

    expect(result).toEqual({ applicationRole: role, created: false });
  }, 30_000);
});
