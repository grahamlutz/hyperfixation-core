import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BootCheckFailure } from "./boot-checks.js";
import { GRANT_RO_EXCLUDED_TABLES } from "./grant-ro.js";
import { migrate } from "./migrate.js";
import { createTestDatabase, type TestDatabase } from "./test-support/database.js";

async function writeMigrationSet(dir: string, tag: string, sql: string): Promise<void> {
  await mkdir(path.join(dir, "meta"), { recursive: true });
  await writeFile(path.join(dir, `${tag}.sql`), sql);
  await writeFile(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [{ idx: 0, version: "7", when: 1, tag, breakpoints: true }],
    }),
  );
}

describe("the five-step migrator", () => {
  let db: TestDatabase;
  let migrator: Client;

  beforeAll(async () => {
    db = await createTestDatabase();
    migrator = new Client({ connectionString: db.migratorUrl });
    await migrator.connect();
  }, 90_000);

  afterAll(async () => {
    await migrator?.end();
    await db?.drop();
  });

  describe("step 1 — core migrations", () => {
    it("applies every core migration and tracks them in drizzle.hf_core_migrations", async () => {
      await migrate(db.migratorUrl, { appName: db.appName });

      const { rows: tables } = await migrator.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
      );
      expect(tables.map((r) => r.relname)).toEqual(
        expect.arrayContaining(["hf_run", "hf_llm_call", "hf_budget_period", "hf_user"]),
      );

      const { rows: applied } = await migrator.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.hf_core_migrations",
      );
      expect(applied[0]?.count).toBe("4");

      const { rows: index } = await migrator.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'hf_llm_call_reservation_idx'",
      );
      expect(index[0]?.indexdef).toContain("INCLUDE");
    });

    it("is idempotent — a second deploy applies nothing new", async () => {
      await migrate(db.migratorUrl, { appName: db.appName });
      const { rows } = await migrator.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.hf_core_migrations",
      );
      expect(rows[0]?.count).toBe("4");
    });
  });

  describe("step 2 — app migrations", () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "hf-app-migrations-"));
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("tracks app migrations in the default table, not the core one", async () => {
      await writeMigrationSet(dir, "0000_app", "CREATE TABLE app_note (id bigint);");
      await migrate(db.migratorUrl, { appName: db.appName, appMigrationsDir: dir });

      const { rows } = await migrator.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
      );
      expect(rows[0]?.count).toBe("1");

      const { rows: core } = await migrator.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM drizzle.hf_core_migrations",
      );
      expect(core[0]?.count).toBe("4");
    });

    it("refuses an app migration that touches an hf_* table, before applying it", async () => {
      await writeMigrationSet(dir, "0000_app", "ALTER TABLE hf_run ADD COLUMN sneaky text;");
      const error = await migrate(db.migratorUrl, {
        appName: db.appName,
        appMigrationsDir: dir,
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(BootCheckFailure);
      expect((error as BootCheckFailure).code).toBe("E005");

      const { rows } = await migrator.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_name = 'hf_run' AND column_name = 'sneaky') AS exists`,
      );
      expect(rows[0]?.exists).toBe(false);
    });
  });

  describe("step 4 — delete-guard triggers", () => {
    beforeAll(async () => {
      await migrator.query(
        "CREATE TABLE IF NOT EXISTS widget (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY)",
      );
      await migrate(db.migratorUrl, {
        appName: db.appName,
        recordTables: [{ table: "widget", recordType: "widget" }],
      });
    }, 60_000);

    afterAll(async () => {
      await migrator.query("DELETE FROM hf_approval");
      await migrator.query("DROP TABLE IF EXISTS widget");
    });

    it("refuses a hard DELETE of a record an approval references", async () => {
      const { rows } = await migrator.query<{ id: string }>(
        "INSERT INTO widget DEFAULT VALUES RETURNING id",
      );
      const id = rows[0]!.id;
      await migrator.query(
        "INSERT INTO hf_approval (run_id, key, workflow_id, type, status, record_type, record_id) " +
          "VALUES ('guarded-run', 'send', 'guarded-run', 'send-email', 'pending', 'widget', $1)",
        [id],
      );

      const error = await migrator.query("DELETE FROM widget WHERE id = $1", [id]).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect((error as { code?: string } | undefined)?.code).toBe("23001");
      expect((error as Error).message).toContain("records.archive()");
    });

    it("allows a DELETE of an unreferenced record", async () => {
      const { rows } = await migrator.query<{ id: string }>(
        "INSERT INTO widget DEFAULT VALUES RETURNING id",
      );
      const result = await migrator.query("DELETE FROM widget WHERE id = $1", [rows[0]!.id]);
      expect(result.rowCount).toBe(1);
    });
  });

  describe("step 5 — hf_grant_ro", () => {
    it("grants the read-only role SELECT on hf_run but not on the auth tables", async () => {
      const ro = new Client({ connectionString: db.readonlyUrl });
      await ro.connect();
      try {
        const { rows } = await ro.query<Record<string, boolean>>(
          `SELECT has_table_privilege('hf_run', 'SELECT') AS run,
                  has_table_privilege('hf_user', 'SELECT') AS "hf_user",
                  has_table_privilege('hf_session', 'SELECT') AS "hf_session",
                  has_table_privilege('hf_account', 'SELECT') AS "hf_account",
                  has_table_privilege('hf_verification', 'SELECT') AS "hf_verification",
                  has_table_privilege('hf_passkey', 'SELECT') AS "hf_passkey"`,
        );
        expect(rows[0]!.run).toBe(true);
        for (const table of GRANT_RO_EXCLUDED_TABLES) {
          expect({ [table]: rows[0]![table] }).toEqual({ [table]: false });
        }
      } finally {
        await ro.end();
      }
    });

    it("no-ops when the read-only role does not exist", async () => {
      const result = await migrate(db.migratorUrl, {
        appName: db.appName,
        readonlyRole: "hf_no_such_ro_role",
      });
      expect(result.grantRo.applied).toBe(false);
    });
  });
});
