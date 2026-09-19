import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { eq, sql } from "drizzle-orm";
import type { NodePgClient } from "drizzle-orm/node-postgres";
import { from as copyFrom } from "pg-copy-streams";
import { hfSourceRun } from "./schema/machinery.js";
import type { StepDatabase } from "./step-pool.js";

/** Structurally what `@hyperfixation/core`'s `SourceRow<P>` is; `db` cannot import `core`. */
export interface SourceRowInput {
  readonly externalId: string;
  readonly payload: unknown;
}

export type SourceRun = typeof hfSourceRun.$inferSelect;

/** `drizzle()` widens the handle it returns; the client it was built over is still on it. */
type WithClient = { readonly $client: NodePgClient };

/**
 * `jsonb`'s text form is canonical, so two payloads differing only in key order hash the same.
 */
const PAYLOAD_HASH = "encode(sha256(convert_to(payload::text, 'UTF8')), 'hex')";

/** The last occurrence of an external id in the batch wins. */
const deduped = (stage: string) =>
  `SELECT DISTINCT ON (external_id) external_id, payload, ${PAYLOAD_HASH} AS payload_hash
   FROM ${stage} ORDER BY external_id, seq DESC`;

function csvField(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function* csvLines(rows: AsyncIterable<SourceRowInput>): AsyncIterable<string> {
  for await (const row of rows) {
    const payload = JSON.stringify(row.payload ?? null);
    yield `${csvField(row.externalId)},${csvField(payload)}\n`;
  }
}

/**
 * COPYs `rows` into a staging table and upserts them into `hf_source_record`, all inside the
 * caller's `ctx.tx`: the `hf_source_run` row and the records commit together or not at all.
 * An unchanged payload moves only `last_seen`; a changed one resets the record to `new` so
 * resolution reruns over it, and never touches its `hf_record_link`.
 */
export async function loadSource(
  tx: StepDatabase,
  source: string,
  rows: AsyncIterable<SourceRowInput>,
): Promise<SourceRun> {
  const client = (tx as unknown as WithClient).$client;

  const [run] = await tx
    .insert(hfSourceRun)
    .values({ source, status: "running" })
    .returning({ id: hfSourceRun.id });
  const runId = run!.id;

  // TEMP, not UNLOGGED: the application role holds USAGE but not CREATE on `public`, and
  // `ON COMMIT DROP` makes the cleanup structural rather than another statement to get right.
  const stage = `hf_source_stage_${runId}`;
  await client.query(
    `CREATE TEMP TABLE ${stage} (
       seq bigint GENERATED ALWAYS AS IDENTITY,
       external_id text NOT NULL,
       payload jsonb NOT NULL
     ) ON COMMIT DROP`,
  );

  const copy = client.query(
    copyFrom(`COPY ${stage} (external_id, payload) FROM STDIN WITH (FORMAT csv)`),
  ) as unknown as Writable;
  await pipeline(Readable.from(csvLines(rows)), copy);

  const counted = await client.query<{
    rows_in: string;
    rows_new: string;
    rows_changed: string;
  }>(
    `WITH deduped AS (${deduped(stage)})
     SELECT
       (SELECT count(*) FROM ${stage}) AS rows_in,
       count(*) FILTER (WHERE r.external_id IS NULL) AS rows_new,
       count(*) FILTER (WHERE r.external_id IS NOT NULL
                          AND r.payload_hash <> d.payload_hash) AS rows_changed
     FROM deduped d
     LEFT JOIN hf_source_record r ON r.source = $1 AND r.external_id = d.external_id`,
    [source],
  );
  const counts = counted.rows[0]!;

  const changed = (column: string) =>
    `CASE WHEN hf_source_record.payload_hash <> EXCLUDED.payload_hash
          THEN EXCLUDED.${column} ELSE hf_source_record.${column} END`;

  await client.query(
    `WITH deduped AS (${deduped(stage)})
     INSERT INTO hf_source_record (source, external_id, payload, payload_hash, run_id)
     SELECT $1, d.external_id, d.payload, d.payload_hash, $2 FROM deduped d
     ON CONFLICT (source, external_id) DO UPDATE SET
       last_seen = now(),
       payload = ${changed("payload")},
       payload_hash = ${changed("payload_hash")},
       run_id = ${changed("run_id")},
       status = CASE WHEN hf_source_record.payload_hash <> EXCLUDED.payload_hash
                     THEN 'new' ELSE hf_source_record.status END,
       attempts = CASE WHEN hf_source_record.payload_hash <> EXCLUDED.payload_hash
                       THEN 0 ELSE hf_source_record.attempts END,
       error = CASE WHEN hf_source_record.payload_hash <> EXCLUDED.payload_hash
                    THEN NULL ELSE hf_source_record.error END`,
    [source, runId],
  );

  const [finished] = await tx
    .update(hfSourceRun)
    .set({
      status: "ok",
      finishedAt: sql`clock_timestamp()`,
      rowsIn: Number(counts.rows_in),
      rowsNew: Number(counts.rows_new),
      rowsChanged: Number(counts.rows_changed),
    })
    .where(eq(hfSourceRun.id, runId))
    .returning();

  return finished!;
}
