import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BootCheckFailure, runBootChecks } from "./boot-checks.js";
import { migrate } from "./migrate.js";
import { asRole, createTestDatabase, type TestDatabase } from "./test-support/database.js";

/**
 * redeploy.test.ts case 10 — round-3 finding 4, both directions. The other
 * eleven cases land later; this one is provable as soon as the migrator exists.
 */
describe("redeploy case 10 — dbos grants", () => {
  describe("with the -r step", () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await createTestDatabase();
      await migrate(db.migratorUrl, { appName: db.appName });
    }, 60_000);

    afterAll(async () => {
      await db?.drop();
    });

    it("gives a real application-role connection USAGE on dbos and INSERT on workflow_status", async () => {
      const row = await asRole(db.applicationUrl, async (client) => {
        const { rows } = await client.query<{
          role: string;
          usage: boolean;
          insert: boolean;
        }>(
          `SELECT current_user AS role,
                  has_schema_privilege('dbos', 'USAGE') AS usage,
                  has_table_privilege('dbos.workflow_status', 'INSERT') AS insert`,
        );
        return rows[0];
      });

      expect(row).toEqual({ role: db.roles.application, usage: true, insert: true });
    });

    it("lets the application role actually write dbos.workflow_status", async () => {
      await asRole(db.applicationUrl, async (client) => {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO dbos.workflow_status (workflow_uuid, status, name)
           VALUES ('case10-probe', 'PENDING', 'probe')`,
        );
        await client.query("ROLLBACK");
      });
    });

    it("passes E001-E006", async () => {
      await expect(runBootChecks({ databaseUrl: db.applicationUrl })).resolves.toBeUndefined();
    });
  });

  describe("without the -r step", () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await createTestDatabase();
      await migrate(db.migratorUrl, { appName: db.appName, dangerouslySkipApplicationRoleGrant: true });
    }, 60_000);

    afterAll(async () => {
      await db?.drop();
    });

    it("fails the boot sequence naming E006, not a raw 42501", async () => {
      const error = await runBootChecks({ databaseUrl: db.applicationUrl }).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(BootCheckFailure);
      expect((error as BootCheckFailure).code).toBe("E006");
      expect((error as BootCheckFailure).message).toContain("E006");
      expect((error as { code?: string }).code).not.toBe("42501");
      expect(String((error as Error).message)).not.toContain("42501");
    });

    it("is guarding a real 42501 — the same role's insert is refused inside a transaction", async () => {
      const error = await asRole(db.applicationUrl, async (client) => {
        await client.query("BEGIN");
        return await client
          .query(
            `INSERT INTO dbos.workflow_status (workflow_uuid, status, name)
             VALUES ('case10-probe', 'PENDING', 'probe')`,
          )
          .then(
            () => undefined,
            (e: unknown) => e,
          )
          .finally(async () => {
            await client.query("ROLLBACK").catch(() => undefined);
          });
      });

      expect((error as { code?: string } | undefined)?.code).toBe("42501");
    });
  });
});
