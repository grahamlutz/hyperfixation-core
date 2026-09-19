import {
  createStepPool,
  loadSource,
  type SourceRowInput,
  type StepDatabase,
  type StepPool,
} from "@hyperfixation/db";
import { asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import type { ClientBase } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defineApp } from "./define-app.js";
import {
  bigramDice,
  fuzzyCandidateStatement,
  resolveBatch,
  type ResolveBatchResult,
} from "./resolution.js";
import { defineResolver, type ResolverDefinition } from "./resolvers.js";

const RUN_ID = "resolution-run";
const TABLE = "businesses";
const SOURCE = "people";

interface RecordRow {
  id: string;
  source: string;
  external_id: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  error: string | null;
}

interface LinkRow {
  id: string;
  source_record_id: string;
  record_type: string;
  record_id: string;
  confidence: number | null;
  method: string;
  decided_by: string | null;
  decided_at: Date | null;
}

let database: TestDatabase;
let step: StepPool;

/** The tx handle is a Drizzle one; every statement here goes through the client under it. */
const clientOf = (db: StepDatabase): ClientBase =>
  (db as unknown as { readonly $client: ClientBase }).$client;

function query<T extends object>(text: string, values: unknown[] = []): Promise<T[]> {
  return asRole(database.applicationUrl, async (client) => {
    const { rows } = await client.query<T>(text, values);
    return rows;
  });
}

const records = () =>
  query<RecordRow>("SELECT * FROM hf_source_record WHERE source = $1 ORDER BY external_id", [
    SOURCE,
  ]);

const links = () =>
  query<LinkRow>("SELECT * FROM hf_record_link ORDER BY source_record_id");

async function* iterate(rows: readonly SourceRowInput[]): AsyncIterable<SourceRowInput> {
  for (const row of rows) yield row;
}

const load = (rows: readonly SourceRowInput[]) =>
  step.tx(RUN_ID, RUN_ID, (tx) => loadSource(tx, SOURCE, iterate(rows)));

const batch = (
  resolver: ResolverDefinition<Record<string, unknown>>,
  options: { limit?: number; maxAttempts?: number } = {},
): Promise<ResolveBatchResult> =>
  step.tx(RUN_ID, RUN_ID, (tx) =>
    resolveBatch(tx, { resolver, table: TABLE, source: SOURCE, ...options }),
  );

const created: string[] = [];
const updated: [string, unknown][] = [];

/** Fails `create` for the payload whose `external` is this, and nothing else. */
let failCreateFor: string | undefined;

type Payload = Record<string, unknown>;

function testResolver(
  overrides: Partial<ResolverDefinition<Payload>> = {},
): ResolverDefinition<Payload> {
  const base: ResolverDefinition<Payload> = {
    name: "business",
    recordType: "business",
    exactKeys: ["email"],
    fuzzy: { field: "normalized_name", payloadKey: "normalized", threshold: 0.3 },
    review: (similarity) => similarity < 0.6,
    async create(payload, db) {
      if (payload.external === failCreateFor) throw new Error("create refused this row");
      const { rows } = await clientOf(db).query<{ id: string }>(
        `INSERT INTO ${TABLE} (name, normalized_name, email) VALUES ($1, $2, $3) RETURNING id`,
        [payload.name, payload.normalized, payload.email],
      );
      created.push(rows[0]!.id);
      return { id: rows[0]!.id };
    },
    async update(id, payload, db) {
      await clientOf(db).query(`UPDATE ${TABLE} SET name = $2 WHERE id = $1`, [id, payload.name]);
      updated.push([id, payload]);
    },
  };
  return defineResolver<Payload>({ ...base, ...overrides });
}

const person = (external: string, email: string, normalized: string): SourceRowInput => ({
  externalId: external,
  payload: { external, email, normalized, name: normalized.toUpperCase() },
});

beforeAll(async () => {
  database = await createTestDatabase();

  // The app table and its trigram index, created the way the app's own migration would:
  // `pg_trgm` and the GIN index on the fuzzy field are what E003 checks for at boot.
  await asRole(database.migratorUrl, async (pg) => {
    await pg.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await pg.query(
      `CREATE TABLE ${TABLE} (
         id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         name text,
         normalized_name text,
         email text,
         archived_at timestamptz)`,
    );
    await pg.query(
      `CREATE INDEX ${TABLE}_normalized_name_idx ON ${TABLE} USING gin (normalized_name gin_trgm_ops)`,
    );
    await pg.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO ${database.roles.application}`,
    );
  });

  await query(
    `INSERT INTO hf_run (run_id, flow, status, attempt, current_workflow_id)
     VALUES ($1, 'resolve', 'running', 1, $1)`,
    [RUN_ID],
  );
  step = createStepPool({ connectionString: database.applicationUrl });
}, 120_000);

afterAll(async () => {
  await step?.end();
  await database?.drop();
});

beforeEach(async () => {
  await query("DELETE FROM hf_record_link");
  await query("DELETE FROM hf_source_record");
  await query("DELETE FROM hf_source_run");
  await query(`DELETE FROM ${TABLE}`);
  created.length = 0;
  updated.length = 0;
  failCreateFor = undefined;
});

describe("bigramDice()", () => {
  it("scores identical strings 1 and disjoint ones 0", () => {
    expect(bigramDice("acme industries", "acme industries")).toBe(1);
    expect(bigramDice("abcd", "wxyz")).toBe(0);
  });

  it("ranks a near miss above a far one", () => {
    const near = bigramDice("acme industries", "acme industrial");
    const far = bigramDice("acme industries", "zenith holdings");
    expect(near).toBeGreaterThan(far);
    expect(near).toBeLessThan(1);
  });
});

describe("resolveBatch()", () => {
  it("gives two rows sharing exact keys one record, and joins the third onto an existing one", async () => {
    const [seeded] = await query<{ id: string }>(
      `INSERT INTO ${TABLE} (name, normalized_name, email) VALUES ('CEE CORP', 'cee corp', 'c@x')
       RETURNING id`,
    );

    await load([
      person("a", "a@x", "alpha holdings"),
      person("b", "a@x", "alpha holdings"),
      person("c", "c@x", "cee corp"),
    ]);

    const result = await batch(testResolver());

    expect(result).toMatchObject({
      scanned: 3,
      created: 1,
      linkedExact: 2,
      linkedFuzzy: 0,
      updated: 0,
      review: 0,
      error: 0,
      done: true,
    });
    expect(created).toHaveLength(1);

    const rows = await links();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.method)).toEqual(["created", "exact", "exact"]);
    // The in-batch duplicate is the same entity, so both rows point at the one new record.
    expect(rows[0]!.record_id).toBe(created[0]);
    expect(rows[1]!.record_id).toBe(created[0]);
    expect(rows[1]!.confidence).toBe(1);
    expect(rows[2]!.record_id).toBe(seeded!.id);

    expect((await records()).map((row) => row.status)).toEqual(["linked", "linked", "linked"]);
    expect(await query(`SELECT id FROM ${TABLE}`)).toHaveLength(2);
  });

  it("updates through a manual link and never rewrites it", async () => {
    const [record] = await query<{ id: string }>(
      `INSERT INTO ${TABLE} (name, normalized_name, email) VALUES ('OLD', 'old name', 'm@x')
       RETURNING id`,
    );
    await load([person("m", "m@x", "old name")]);
    const [row] = await records();
    await query(
      `INSERT INTO hf_record_link (source_record_id, record_type, record_id, method, decided_by, decided_at)
       VALUES ($1, 'business', $2, 'manual', 'graham', now())`,
      [row!.id, record!.id],
    );
    const before = await links();

    // A changed payload resets the record to `new`, which is what brings it back into the scan.
    await load([
      { externalId: "m", payload: { external: "m", email: "m@x", normalized: "new name", name: "NEW" } },
    ]);
    expect((await records())[0]!.status).toBe("new");

    const result = await batch(testResolver());

    expect(result).toMatchObject({ scanned: 1, updated: 1, created: 0, linkedExact: 0, error: 0 });
    expect(updated).toEqual([[record!.id, expect.objectContaining({ name: "NEW" })]]);
    expect(await links()).toEqual(before);
    expect((await records())[0]!.status).toBe("linked");
    expect(await query(`SELECT name FROM ${TABLE}`)).toEqual([{ name: "NEW" }]);
  });

  it("marks a row whose create throws `error` and finishes the batch", async () => {
    await load([
      person("a", "a@x", "alpha holdings"),
      person("b", "b@x", "bravo trading"),
      person("c", "c@x", "charlie mining"),
    ]);
    failCreateFor = "b";

    const result = await batch(testResolver());

    expect(result).toMatchObject({ scanned: 3, created: 2, error: 1, done: true });
    const rows = await records();
    expect(rows.map((row) => [row.external_id, row.status, row.attempts])).toEqual([
      ["a", "linked", 0],
      ["b", "error", 1],
      ["c", "linked", 0],
    ]);
    expect(rows[1]!.error).toContain("create refused this row");
    expect(await links()).toHaveLength(2);

    // No savepoint leaked: the next batch on the same pool re-scans the error row and links it.
    failCreateFor = undefined;
    const retry = await batch(testResolver());
    expect(retry).toMatchObject({ scanned: 1, created: 1, error: 0 });
    expect((await records())[1]!.status).toBe("linked");
  });

  it("links a fuzzy candidate the resolver accepts", async () => {
    const [record] = await query<{ id: string }>(
      `INSERT INTO ${TABLE} (name, normalized_name, email) VALUES ('ACME', 'acme industries', 'old@x')
       RETURNING id`,
    );
    await load([person("f", "new@x", "acme industries")]);

    const result = await batch(testResolver());

    expect(result).toMatchObject({ scanned: 1, linkedFuzzy: 1, created: 0, linkedExact: 0 });
    const [link] = await links();
    expect(link).toMatchObject({ method: "fuzzy", record_id: record!.id, confidence: 1 });
    expect(updated).toHaveLength(1);
  });

  it("parks a row in `review` without a link when review() is true", async () => {
    await query(
      `INSERT INTO ${TABLE} (name, normalized_name, email) VALUES ('ACME', 'acme industries', 'old@x')`,
    );
    await load([person("r", "new@x", "acme industries")]);

    const result = await batch(testResolver({ review: () => true }));

    expect(result).toMatchObject({ scanned: 1, review: 1, linkedFuzzy: 0, created: 0 });
    expect(await links()).toEqual([]);
    expect((await records())[0]!.status).toBe("review");

    // A `review` row is not terminal: the next batch scans it again.
    expect(await batch(testResolver({ review: () => true }))).toMatchObject({ scanned: 1 });
  });

  it("skips an error row that has reached maxAttempts", async () => {
    await load([person("a", "a@x", "alpha holdings")]);
    await query("UPDATE hf_source_record SET status = 'error', attempts = 3");

    const resolver = testResolver();
    const create = vi.spyOn(resolver, "create");

    expect(await batch(resolver, { maxAttempts: 3 })).toMatchObject({ scanned: 0, done: true });
    expect(create).not.toHaveBeenCalled();
    expect(await batch(resolver, { maxAttempts: 4 })).toMatchObject({ scanned: 1, created: 1 });
  });

  it("reports the batch unfinished while the scan fills its limit", async () => {
    await load([person("a", "a@x", "alpha holdings"), person("b", "b@x", "bravo trading")]);

    expect(await batch(testResolver(), { limit: 1 })).toMatchObject({ scanned: 1, done: false });
    expect(await batch(testResolver(), { limit: 1 })).toMatchObject({ scanned: 1, done: false });
    expect(await batch(testResolver(), { limit: 1 })).toMatchObject({ scanned: 0, done: true });
  });

  it("resolves the table and the resolver through defineApp's registries", async () => {
    const resolver = testResolver();
    const app = defineApp({
      name: database.appName,
      applicationVersion: "sha1234567",
      resolvers: [resolver],
      records: [{ table: TABLE, recordType: "business" }],
    });

    await load([person("a", "a@x", "alpha holdings")]);
    const result = await step.tx(RUN_ID, RUN_ID, (tx) =>
      app.resolution.batch(tx, { resolver: "business", source: SOURCE }),
    );

    expect(result).toMatchObject({ scanned: 1, created: 1 });
    expect(await links()).toHaveLength(1);
  });
});

describe("the fuzzy candidate query at 200k rows", () => {
  const BIG = "big_businesses";
  const needle = "acme industries limited";

  beforeAll(async () => {
    await asRole(database.migratorUrl, async (pg) => {
      await pg.query(
        `CREATE TABLE ${BIG} (
           id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
           normalized_name text,
           archived_at timestamptz)`,
      );
      await pg.query(
        `INSERT INTO ${BIG} (normalized_name)
         SELECT 'company number ' || g FROM generate_series(1, 200000) g`,
      );
      await pg.query(`INSERT INTO ${BIG} (normalized_name) VALUES ($1)`, [needle]);
      await pg.query(
        `CREATE INDEX ${BIG}_normalized_name_idx ON ${BIG} USING gin (normalized_name gin_trgm_ops)`,
      );
      await pg.query(`ANALYZE ${BIG}`);
      await pg.query(`GRANT SELECT ON ${BIG} TO ${database.roles.application}`);
    });
  }, 60_000);

  afterAll(async () => {
    await asRole(database.migratorUrl, (pg) => pg.query(`DROP TABLE IF EXISTS ${BIG}`));
  });

  it("uses the trigram index and no sequential scan", async () => {
    const statement = fuzzyCandidateStatement(BIG, "normalized_name");

    // EXPLAIN classifies as a write, so it runs inside `ctx.tx` like the real statement does.
    const plan = await step.tx(RUN_ID, RUN_ID, async (tx) => {
      await clientOf(tx).query("SET LOCAL pg_trgm.similarity_threshold = 0.3000000000");
      const { rows } = await clientOf(tx).query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (FORMAT JSON) ${statement}`,
        [needle],
      );
      return JSON.stringify(rows[0]!["QUERY PLAN"]);
    });

    expect(plan).toContain(`${BIG}_normalized_name_idx`);
    expect(plan).toContain("Bitmap Index Scan");
    expect(plan).not.toContain("Seq Scan");
  });

  it("returns the one similar row", async () => {
    const statement = fuzzyCandidateStatement(BIG, "normalized_name");
    const rows = await step.tx(RUN_ID, RUN_ID, async (tx) => {
      await clientOf(tx).query("SET LOCAL pg_trgm.similarity_threshold = 0.3000000000");
      const result = await clientOf(tx).query<{ normalized_name: string }>(statement, [needle]);
      return result.rows;
    });

    expect(rows.map((row) => row.normalized_name)).toEqual([needle]);
  });
}, 60_000);
