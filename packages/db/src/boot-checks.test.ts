import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BootCheckFailure,
  checkE001,
  checkE002,
  checkE003,
  checkE004,
  checkE005,
  checkE006,
  runBootChecks,
} from "./boot-checks.js";
import { migrate } from "./migrate.js";
import {
  ADMIN_URL,
  asRole,
  createTestDatabase,
  type TestDatabase,
} from "./test-support/database.js";

async function failureOf(work: Promise<unknown>): Promise<BootCheckFailure> {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BootCheckFailure);
  return error as BootCheckFailure;
}

describe("boot checks E001-E006", () => {
  let db: TestDatabase;
  let migrator: Client;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.migratorUrl, { appName: db.appName });
    migrator = new Client({ connectionString: db.migratorUrl });
    await migrator.connect();
  }, 90_000);

  afterAll(async () => {
    await migrator?.end();
    await db?.drop();
  });

  describe("E001 — registered record tables have a bigint identity primary key named id", () => {
    afterEach(async () => {
      await migrator.query("DROP TABLE IF EXISTS widget, bad_widget");
    });

    it("passes on a conforming table", async () => {
      await migrator.query(
        "CREATE TABLE widget (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text)",
      );
      await expect(
        checkE001(migrator, [{ table: "widget", recordType: "widget" }]),
      ).resolves.toBeUndefined();
    });

    it("passes vacuously when no record table is registered", async () => {
      await expect(checkE001(migrator, [])).resolves.toBeUndefined();
    });

    it("fails on a non-identity text primary key", async () => {
      await migrator.query("CREATE TABLE bad_widget (id text PRIMARY KEY)");
      const failure = await failureOf(
        checkE001(migrator, [{ table: "bad_widget", recordType: "widget" }]),
      );
      expect(failure.code).toBe("E001");
      expect(failure.details[0]).toContain("id is text, not bigint");
    });

    it("fails on a table that does not exist", async () => {
      const failure = await failureOf(
        checkE001(migrator, [{ table: "no_such_table", recordType: "widget" }]),
      );
      expect(failure.code).toBe("E001");
    });
  });

  describe("E002 — every stored record_type is registered", () => {
    beforeAll(async () => {
      await migrator.query(
        "INSERT INTO hf_approval (run_id, key, workflow_id, type, status, record_type, record_id) " +
          "VALUES ('e002-run', 'send', 'e002-run', 'send-email', 'pending', 'widget', '1')",
      );
    });

    afterAll(async () => {
      await migrator.query("DELETE FROM hf_approval");
    });

    it("passes when the type is registered", async () => {
      await expect(
        checkE002(migrator, [{ table: "widget", recordType: "widget" }]),
      ).resolves.toBeUndefined();
    });

    it("fails when a machinery row names an unregistered type", async () => {
      const failure = await failureOf(checkE002(migrator, []));
      expect(failure.code).toBe("E002");
      expect(failure.details).toContain('hf_approval: "widget"');
    });

    it.each([
      ["hf_record_link", "INSERT INTO hf_record_link (source_record_id, record_type, record_id, method) VALUES (1, 'planted', '1', 'exact')"],
      ["hf_score", "INSERT INTO hf_score (record_type, record_id, spec_version, score) VALUES ('planted', '1', 1, 0.5)"],
      ["hf_activity", "INSERT INTO hf_activity (record_type, record_id, kind) VALUES ('planted', '1', 'note')"],
      ["hf_task", "INSERT INTO hf_task (record_type, record_id, title, origin) VALUES ('planted', '1', 't', 'manual')"],
      ["hf_label", "INSERT INTO hf_label (record_type, record_id, target, value) VALUES ('planted', '1', 'record', 'up')"],
      ["hf_outcome", "INSERT INTO hf_outcome (record_type, record_id, outcome) VALUES ('planted', '1', 'won')"],
    ])("scans %s for unregistered record types", async (table, insert) => {
      await migrator.query(insert);
      try {
        const failure = await failureOf(checkE002(migrator, [{ table: "widget", recordType: "widget" }]));
        expect(failure.code).toBe("E002");
        expect(failure.details).toContain(`${table}: "planted"`);
      } finally {
        await migrator.query(`DELETE FROM ${table}`);
      }
    });

    it("ignores a row attached to no record at all", async () => {
      await migrator.query(
        `INSERT INTO hf_run (run_id, flow, status, current_workflow_id)
         VALUES ('e002-no-record', 'demo', 'running', 'e002-no-record')`,
      );

      await expect(
        checkE002(migrator, [{ table: "widget", recordType: "widget" }]),
      ).resolves.toBeUndefined();
    });
  });

  describe("E003 — registered record tables carry the trigram index", () => {
    beforeAll(async () => {
      await migrator.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
      await migrator.query(
        "CREATE TABLE trgm_widget (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, normalized_name text)",
      );
      await migrator.query("CREATE TABLE plain_widget (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, normalized_name text)");
      await migrator.query(
        "CREATE INDEX trgm_widget_normalized_name_idx ON trgm_widget USING gin (normalized_name gin_trgm_ops)",
      );
    });

    afterAll(async () => {
      await migrator.query("DROP TABLE IF EXISTS trgm_widget, plain_widget");
    });

    it("passes when the GIN trigram index is present", async () => {
      await expect(
        checkE003(migrator, [{ table: "trgm_widget", recordType: "widget" }]),
      ).resolves.toBeUndefined();
    });

    it("fails when it is missing", async () => {
      const failure = await failureOf(
        checkE003(migrator, [{ table: "plain_widget", recordType: "widget" }]),
      );
      expect(failure.code).toBe("E003");
      expect(failure.details[0]).toContain("gin_trgm_ops");
    });
  });

  describe("E004 — no app foreign key into an hf_* table", () => {
    it("passes on a freshly migrated database", async () => {
      await expect(checkE004(migrator)).resolves.toBeUndefined();
    });

    it("fails when an app table references hf_user", async () => {
      await migrator.query(
        "CREATE TABLE app_note (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner_id text REFERENCES hf_user(id))",
      );
      try {
        const failure = await failureOf(checkE004(migrator));
        expect(failure.code).toBe("E004");
        expect(failure.details[0]).toContain("app_note -> hf_user");
      } finally {
        await migrator.query("DROP TABLE IF EXISTS app_note");
      }
    });
  });

  describe("E005 — app migrations never touch hf_* tables", () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "hf-e005-"));
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    afterEach(async () => {
      await rm(path.join(dir, "0000_fixture.sql"), { force: true });
    });

    it("passes when no app migrations directory is given", async () => {
      await expect(checkE005(undefined)).resolves.toBeUndefined();
    });

    it("passes on a migration that only touches app tables", async () => {
      await writeFile(
        path.join(dir, "0000_fixture.sql"),
        "CREATE TABLE app_note (id bigint);\n--> statement-breakpoint\nALTER TABLE app_note ADD COLUMN body text;\n",
      );
      await expect(checkE005(dir)).resolves.toBeUndefined();
    });

    it("fails on ALTER TABLE hf_run", async () => {
      await writeFile(
        path.join(dir, "0000_fixture.sql"),
        "ALTER TABLE hf_run ADD COLUMN sneaky text;\n",
      );
      const failure = await failureOf(checkE005(dir));
      expect(failure.code).toBe("E005");
      expect(failure.details[0]).toContain("ALTER TABLE hf_run");
    });

    it("fails on CREATE TABLE hf_shadow", async () => {
      await writeFile(path.join(dir, "0000_fixture.sql"), "CREATE TABLE hf_shadow (id bigint);\n");
      const failure = await failureOf(checkE005(dir));
      expect(failure.code).toBe("E005");
      expect(failure.details[0]).toContain("CREATE TABLE hf_shadow");
    });
  });

  describe("E006 — the application role's dbos grants", () => {
    it("passes for the application role after a full migrate", async () => {
      await asRole(db.applicationUrl, async (client) => {
        await expect(checkE006(client)).resolves.toBeUndefined();
      });
    });

    it("fails for a role the -r step never named, without leaking 42501", async () => {
      await asRole(db.readonlyUrl, async (client) => {
        const failure = await failureOf(checkE006(client));
        expect(failure.code).toBe("E006");
        expect(failure.message).toContain("dbos schema -s dbos -r");
        expect(failure.details).toContain("has_schema_privilege('dbos', 'USAGE') is false");
        expect(failure.message).not.toContain("42501");
      });
    });

    it("fails cleanly when the dbos schema does not exist at all", async () => {
      await asRole(ADMIN_URL, async (client) => {
        const failure = await failureOf(checkE006(client));
        expect(failure.code).toBe("E006");
        expect(failure.details).toEqual([
          "has_schema_privilege('dbos', 'USAGE') is false",
          "has_table_privilege('dbos.workflow_status', 'INSERT') is false",
        ]);
      });
    });
  });

  it("runBootChecks passes end to end as the application role", async () => {
    await expect(runBootChecks({ databaseUrl: db.applicationUrl })).resolves.toBeUndefined();
  });
});
