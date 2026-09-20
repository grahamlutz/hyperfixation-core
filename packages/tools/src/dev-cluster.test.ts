import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADMIN_URL,
  dropLeaked,
  leakedDatabases,
  likePrefix,
  rolesFor,
  TEST_PREFIX,
  type LeakedDatabase,
} from "./dev-cluster.js";

/** Two databases shaped exactly like `createTestDatabase`'s leftovers, one with a backend. */
const idle = `hf_test_${randomBytes(5).toString("hex")}`;
const busy = `hf_test_${randomBytes(5).toString("hex")}`;

let admin: Client;
let backend: Client;

async function exists(name: string): Promise<boolean> {
  const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return rowCount === 1;
}

async function roleExists(name: string): Promise<boolean> {
  const { rowCount } = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
  return rowCount === 1;
}

async function selected(name: string): Promise<LeakedDatabase> {
  const found = (await leakedDatabases(admin, TEST_PREFIX)).find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`${name} was not selected as leaked`);
  return found;
}

beforeAll(async () => {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const name of [idle, busy]) {
    await admin.query(`CREATE DATABASE "${name}"`);
    for (const role of rolesFor(name)) {
      await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'leaked'`);
    }
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${busy}`;
  backend = new Client({ connectionString: url.toString() });
  await backend.connect();
});

afterAll(async () => {
  await backend?.end();
  for (const name of [idle, busy]) {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    for (const role of rolesFor(name)) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
  }
  await admin.end();
});

describe("leakedDatabases", () => {
  it("selects the database with no backend and not the one being used", async () => {
    const leaked = (await leakedDatabases(admin, TEST_PREFIX)).map(({ name }) => name);

    expect(leaked).toContain(idle);
    expect(leaked).not.toContain(busy);
  });

  it("derives the roles provisionRoles created for the database", async () => {
    expect((await selected(idle)).roles).toEqual([`${idle}_migrator`, idle, `${idle}_ro`]);
  });

  it("does not match a name the prefix's underscores would wildcard into", () => {
    expect(likePrefix("hf_test_")).toBe("hf\\_test\\_%");
  });
});

describe("dropLeaked", () => {
  it("drops the database and its three roles, leaving the busy one alone", async () => {
    await dropLeaked(admin, await selected(idle));

    expect(await exists(idle)).toBe(false);
    for (const role of rolesFor(idle)) expect(await roleExists(role)).toBe(false);
    expect(await exists(busy)).toBe(true);
    for (const role of rolesFor(busy)) expect(await roleExists(role)).toBe(true);
  });
});

describe("rolesFor", () => {
  it("names a scratch app's roles from its scratch_<name> database", () => {
    expect(rolesFor("scratch_demo")).toEqual(["hf_demo_migrator", "hf_demo", "hf_demo_ro"]);
  });
});
