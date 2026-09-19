import { createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapAdmin, BootstrapRefused } from "./bootstrap.js";

describe("the bootstrap user", () => {
  let database: TestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = new Pool({ connectionString: database.applicationUrl, max: 4 });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM hf_user");
    await pool.query("DELETE FROM hf_audit");
  });

  const roleOf = async (email: string): Promise<string | null> => {
    const { rows } = await pool.query<{ role: string | null }>(
      "SELECT role FROM hf_user WHERE email = $1",
      [email],
    );
    return rows[0]?.role ?? null;
  };

  it("makes the first user of an empty app an admin", async () => {
    const result = await bootstrapAdmin(pool, {
      email: "owner@app.test",
      name: "Owner",
      designatedEmail: null,
    });

    expect(result).toEqual({ userId: expect.any(String), email: "owner@app.test", created: true });
    expect(await roleOf("owner@app.test")).toBe("admin");
  });

  it("promotes the designated address, existing row or not", async () => {
    await pool.query(
      "INSERT INTO hf_user (id, name, email) VALUES ('u-existing', 'Crystal', 'crystal@app.test')",
    );

    const result = await bootstrapAdmin(pool, {
      email: "crystal@app.test",
      designatedEmail: "crystal@app.test",
    });

    expect(result).toEqual({ userId: "u-existing", email: "crystal@app.test", created: false });
    expect(await roleOf("crystal@app.test")).toBe("admin");
  });

  it("bootstraps the designated address when that is the only one given", async () => {
    const result = await bootstrapAdmin(pool, { designatedEmail: "crystal@app.test" });

    expect(result).toEqual({ userId: expect.any(String), email: "crystal@app.test", created: true });
    expect(await roleOf("crystal@app.test")).toBe("admin");
  });

  it("prefers the email over the designation, which then has to match", async () => {
    await expect(
      bootstrapAdmin(pool, { email: "someone@app.test", designatedEmail: "owner@app.test" }),
    ).rejects.toMatchObject({ reason: "not-designated" });
  });

  it("refuses with a reason rather than crashing when neither names an address", async () => {
    const refusal = await bootstrapAdmin(pool, { designatedEmail: null }).catch(
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(BootstrapRefused);
    expect((refusal as BootstrapRefused).reason).toBe("no-designation");
  });

  it("writes one audit row naming who it made", async () => {
    const { userId } = await bootstrapAdmin(pool, {
      email: "owner@app.test",
      designatedEmail: null,
    });

    const { rows } = await pool.query<{ action: string; target_id: string; meta: unknown }>(
      "SELECT action, target_id, meta FROM hf_audit",
    );
    expect(rows).toEqual([
      {
        action: "auth.bootstrapped",
        target_id: userId,
        meta: { email: "owner@app.test", created: true, designated: false },
      },
    ]);
  });

  it("refuses once anybody is an admin — it is the one-time path, and it is enforced", async () => {
    await bootstrapAdmin(pool, { email: "owner@app.test", designatedEmail: null });

    const refusal = await bootstrapAdmin(pool, {
      email: "second@app.test",
      designatedEmail: "second@app.test",
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(BootstrapRefused);
    expect((refusal as BootstrapRefused).reason).toBe("admin-exists");
    expect(await roleOf("second@app.test")).toBeNull();
  });

  it("sees an admin hidden in a comma-separated role list", async () => {
    await pool.query(
      "INSERT INTO hf_user (id, name, email, role) VALUES ('u-1', 'A', 'a@app.test', 'member, admin')",
    );

    await expect(
      bootstrapAdmin(pool, { email: "b@app.test", designatedEmail: "b@app.test" }),
    ).rejects.toMatchObject({ reason: "admin-exists" });
  });

  it("refuses an address the deploy did not designate", async () => {
    const refusal = await bootstrapAdmin(pool, {
      email: "someone@app.test",
      designatedEmail: "owner@app.test",
    }).catch((error: unknown) => error);

    expect((refusal as BootstrapRefused).reason).toBe("not-designated");
    expect(await roleOf("someone@app.test")).toBeNull();
  });

  it("refuses to pick a first user out of a populated table", async () => {
    await pool.query(
      "INSERT INTO hf_user (id, name, email) VALUES ('u-1', 'A', 'a@app.test'), ('u-2', 'B', 'b@app.test')",
    );

    const refusal = await bootstrapAdmin(pool, {
      email: "c@app.test",
      designatedEmail: null,
    }).catch((error: unknown) => error);

    expect((refusal as BootstrapRefused).reason).toBe("not-first-user");
    expect(await roleOf("c@app.test")).toBeNull();
  });

  it("lets exactly one of two concurrent runs grant the role", async () => {
    const attempts = await Promise.allSettled([
      bootstrapAdmin(pool, { email: "first@app.test", designatedEmail: "first@app.test" }),
      bootstrapAdmin(pool, { email: "second@app.test", designatedEmail: "second@app.test" }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const { rows } = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM hf_user WHERE role = 'admin'",
    );
    expect(rows[0]!.count).toBe(1);
  });
});
