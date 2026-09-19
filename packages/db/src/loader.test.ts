import { from as copyFrom } from "pg-copy-streams";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UnfencedWrite, unfencedWriteOf } from "./fenced-client.js";
import { loadSource, type SourceRowInput, type SourceRun } from "./loader.js";
import { migrate } from "./migrate.js";
import { createStepPool, type StepPool } from "./step-pool.js";
import { asRole, createTestDatabase, type TestDatabase } from "./test-support/database.js";

const RUN_ID = "loader-run";
const WORKFLOW_ID = "loader-run";

interface RecordRow {
  id: string;
  source: string;
  external_id: string;
  payload: unknown;
  payload_hash: string;
  status: string;
  attempts: number;
  error: string | null;
  run_id: string | null;
  first_seen: Date;
  last_seen: Date;
}

let database: TestDatabase;
let step: StepPool;

async function* iterate(rows: readonly SourceRowInput[]): AsyncIterable<SourceRowInput> {
  for (const row of rows) yield row;
}

function load(source: string, rows: AsyncIterable<SourceRowInput>): Promise<SourceRun> {
  return step.tx(RUN_ID, WORKFLOW_ID, (tx) => loadSource(tx, source, rows));
}

/** Every assertion reads through a connection of its own, outside the fence and the pool. */
function query<T extends object>(text: string, values: unknown[] = []): Promise<T[]> {
  return asRole(database.applicationUrl, async (client) => {
    const { rows } = await client.query<T>(text, values);
    return rows;
  });
}

function records(source: string): Promise<RecordRow[]> {
  return query<RecordRow>(
    "SELECT * FROM hf_source_record WHERE source = $1 ORDER BY external_id",
    [source],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.migratorUrl, { appName: database.appName });
  await query(
    `INSERT INTO hf_run (run_id, flow, status, attempt, current_workflow_id)
     VALUES ($1, 'demo', 'running', 1, $2)`,
    [RUN_ID, WORKFLOW_ID],
  );
  step = createStepPool({ connectionString: database.applicationUrl });
}, 60_000);

afterAll(async () => {
  await step?.end();
  await database?.drop();
});

beforeEach(async () => {
  await query("DELETE FROM hf_record_link");
  await query("DELETE FROM hf_source_record");
  await query("DELETE FROM hf_source_run");
});

describe("loadSource", () => {
  it("loads a batch with a duplicate external id once, keeping the later payload", async () => {
    const run = await load(
      "people",
      iterate([
        { externalId: "a", payload: { name: "Ada" } },
        { externalId: "b", payload: { name: "Bob" } },
        { externalId: "a", payload: { name: "Ada Lovelace" } },
      ]),
    );

    expect(run.status).toBe("ok");
    expect(run.finishedAt).toBeInstanceOf(Date);
    expect([run.rowsIn, run.rowsNew, run.rowsChanged]).toEqual([3, 2, 0]);

    const rows = await records("people");
    expect(rows.map((r) => r.external_id)).toEqual(["a", "b"]);
    expect(rows[0]!.payload).toEqual({ name: "Ada Lovelace" });
    expect(rows.map((r) => r.status)).toEqual(["new", "new"]);
    expect(rows.every((r) => r.run_id === String(run.id))).toBe(true);
  });

  it("leaves no staging table behind after the transaction commits", async () => {
    await load("people", iterate([{ externalId: "a", payload: { name: "Ada" } }]));

    const staging = await query<{ relname: string }>(
      "SELECT relname FROM pg_class WHERE relname LIKE 'hf_source_stage%'",
    );
    expect(staging).toEqual([]);
  });

  it("moves only last_seen when the payload is unchanged", async () => {
    const batch = [
      { externalId: "a", payload: { name: "Ada" } },
      { externalId: "b", payload: { name: "Bob" } },
    ];
    const first = await load("people", iterate(batch));
    await query("UPDATE hf_source_record SET status = 'linked' WHERE external_id = 'a'");
    const before = await records("people");

    const second = await load("people", iterate(batch));

    expect([second.rowsIn, second.rowsNew, second.rowsChanged]).toEqual([2, 0, 0]);
    const after = await records("people");
    for (const [index, row] of after.entries()) {
      const was = before[index]!;
      expect(row.last_seen.getTime()).toBeGreaterThan(was.last_seen.getTime());
      expect(row.first_seen).toEqual(was.first_seen);
      expect(row.payload_hash).toBe(was.payload_hash);
      expect(row.status).toBe(was.status);
      expect(row.run_id).toBe(String(first.id));
    }
    expect(second.id).not.toBe(first.id);
  });

  it("resets a changed record to new without touching its link", async () => {
    await load("people", iterate([{ externalId: "a", payload: { name: "Ada" } }]));
    const [seeded] = await records("people");
    await query(
      `INSERT INTO hf_record_link (source_record_id, record_type, record_id, method, decided_by, decided_at)
       VALUES ($1, 'person', 'p-1', 'manual', 'graham', now())`,
      [seeded!.id],
    );
    await query(
      "UPDATE hf_source_record SET status = 'linked', attempts = 2, error = 'stale' WHERE id = $1",
      [seeded!.id],
    );
    const [link] = await query<Record<string, unknown>>("SELECT * FROM hf_record_link");

    const run = await load("people", iterate([{ externalId: "a", payload: { name: "Ada L." } }]));

    expect([run.rowsIn, run.rowsNew, run.rowsChanged]).toEqual([1, 0, 1]);
    const [row] = await records("people");
    expect(row!.payload).toEqual({ name: "Ada L." });
    expect(row!.payload_hash).not.toBe(seeded!.payload_hash);
    expect(row!.status).toBe("new");
    expect(row!.attempts).toBe(0);
    expect(row!.error).toBeNull();
    expect(row!.run_id).toBe(String(run.id));
    expect(await query<Record<string, unknown>>("SELECT * FROM hf_record_link")).toEqual([link]);
  });

  it("treats a payload that differs only in key order as unchanged", async () => {
    await load("people", iterate([{ externalId: "a", payload: { name: "Ada", city: "London" } }]));
    const [before] = await records("people");

    const run = await load(
      "people",
      iterate([{ externalId: "a", payload: { city: "London", name: "Ada" } }]),
    );

    expect(run.rowsChanged).toBe(0);
    const [after] = await records("people");
    expect(after!.payload_hash).toBe(before!.payload_hash);
  });

  it("round-trips payloads that stress CSV quoting", async () => {
    const payload = {
      note: 'a "quoted", comma-laden\nline',
      unicode: "é — 日本語 \\ backslash",
    };

    const run = await load("people", iterate([{ externalId: 'odd,"id"', payload }]));

    expect(run.rowsIn).toBe(1);
    const [row] = await records("people");
    expect(row!.external_id).toBe('odd,"id"');
    expect(row!.payload).toEqual(payload);
  });

  it("rolls the run back when the source iterator throws", async () => {
    async function* throwing(): AsyncIterable<SourceRowInput> {
      yield { externalId: "a", payload: { name: "Ada" } };
      yield { externalId: "b", payload: { name: "Bob" } };
      throw new Error("source exploded");
    }

    await expect(load("people", throwing())).rejects.toThrow("source exploded");

    expect(await query("SELECT 1 FROM hf_source_run")).toEqual([]);
    expect(await records("people")).toEqual([]);
    // The failed COPY must not poison the connection it ran on.
    const after = await load("people", iterate([{ externalId: "a", payload: { name: "Ada" } }]));
    expect(after.status).toBe("ok");
  });
});

describe("the fence", () => {
  it("refuses a COPY on a step-pool connection outside ctx.tx", async () => {
    const client = await step.pool.connect();
    try {
      const copy = () =>
        client.query(
          copyFrom(
            "COPY hf_source_record (source, external_id, payload, payload_hash) FROM STDIN WITH (FORMAT csv)",
          ),
        );

      expect(copy).toThrow(UnfencedWrite);
      let refused: UnfencedWrite | undefined;
      try {
        copy();
      } catch (error) {
        refused = error as UnfencedWrite;
      }
      expect(refused!.statement).toMatch(/^COPY hf_source_record/);
    } finally {
      client.release();
    }
  });

  it("refuses loadSource called outside ctx.tx", async () => {
    const error = await loadSource(step.db, "unfenced", iterate([])).catch(
      (thrown: unknown) => thrown,
    );

    expect(unfencedWriteOf(error)).toBeInstanceOf(UnfencedWrite);
  });
});
