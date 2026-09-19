import { quoteIdent, type StepDatabase } from "@hyperfixation/db";
import type { ClientBase } from "pg";
import { InvalidDefinition } from "./registry.js";
import type { ResolverDefinition } from "./resolvers.js";

/** `drizzle()` widens the handle it returns; the client it was built over is still on it. */
type WithClient = { readonly $client: ClientBase };

export const DEFAULT_RESOLVE_LIMIT = 500;
export const DEFAULT_RESOLVE_MAX_ATTEMPTS = 3;

/** How many trigram candidates the re-ranker looks at; the GIN index orders nothing. */
export const FUZZY_CANDIDATE_LIMIT = 20;

/** Reused per row rather than named per id: `RELEASE` always releases the innermost one. */
const SAVEPOINT = "hf_resolve_row";

const SCAN_STATEMENT =
  "SELECT id, payload FROM hf_source_record " +
  "WHERE source = $1 AND status <> 'linked' AND attempts < $2 ORDER BY id LIMIT $3 FOR UPDATE";

const LINKS_STATEMENT =
  "SELECT source_record_id, record_id FROM hf_record_link WHERE source_record_id = ANY($1::bigint[])";

const INSERT_LINK_STATEMENT =
  "INSERT INTO hf_record_link (source_record_id, record_type, record_id, confidence, method) " +
  "VALUES ($1, $2, $3, $4, $5)";

const LINKED_STATEMENT = "UPDATE hf_source_record SET status = 'linked', error = NULL WHERE id = $1";

const REVIEW_STATEMENT = "UPDATE hf_source_record SET status = 'review', error = NULL WHERE id = $1";

const ERROR_STATEMENT =
  "UPDATE hf_source_record SET status = 'error', attempts = attempts + 1, error = $2 WHERE id = $1";

/**
 * The candidate query, exported so a test can `EXPLAIN` the statement resolution really issues
 * rather than a hand-copied lookalike. `%` is what the GIN trigram index answers; the
 * `ORDER BY` is a sort over the bitmap heap scan's output, not an index walk.
 */
export function fuzzyCandidateStatement(table: string, field: string): string {
  const column = quoteIdent(field);
  return (
    `SELECT id, ${column} FROM ${quoteIdent(table)} ` +
    `WHERE ${column} % $1 AND archived_at IS NULL ` +
    `ORDER BY similarity(${column}, $1) DESC LIMIT ${FUZZY_CANDIDATE_LIMIT}`
  );
}

export interface ResolveBatchOptions {
  resolver: ResolverDefinition;
  /** The app table the resolver's `recordType` lives in; `exactKeys` are columns on it. */
  table: string;
  source: string;
  /** Rows per call, and per transaction: the caller loops until `done`. Defaults to 500. */
  limit?: number | undefined;
  maxAttempts?: number | undefined;
}

export interface ResolveBatchResult {
  scanned: number;
  linkedExact: number;
  linkedFuzzy: number;
  created: number;
  /** Rows that already carried a link: the record was updated and the link left alone. */
  updated: number;
  review: number;
  error: number;
  /**
   * False while the scan filled its `limit` *and* the batch moved at least one row out of the
   * scan, so the caller has another batch to run.
   */
  done: boolean;
}

type Payload = Record<string, unknown>;

interface ScanRow {
  id: string;
  payload: Payload;
}

/** What a group leader settled on, for the rest of its group to follow. */
type Outcome = { kind: "record"; recordId: string } | { kind: "review" } | { kind: "error" };

function bigrams(value: string): Map<string, number> {
  const grams = new Map<string, number>();
  for (let i = 0; i + 1 < value.length; i += 1) {
    const gram = value.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/**
 * Dice coefficient over bigram multisets, in [0, 1]. Postgres's `similarity()` already ordered
 * the candidates; this re-ranks them in process, where the comparison is free and a resolver's
 * `review()` threshold can be read against one scale that does not move with a Postgres upgrade.
 */
export function bigramDice(a: string, b: string): number {
  if (a === b) return 1;
  const left = bigrams(a);
  let total = 0;
  let shared = 0;
  for (const count of left.values()) total += count;
  for (const [gram, count] of bigrams(b)) {
    total += count;
    shared += Math.min(count, left.get(gram) ?? 0);
  }
  return total === 0 ? 0 : (2 * shared) / total;
}

function thresholdLiteral(resolver: ResolverDefinition, threshold: number): string {
  if (!(threshold > 0 && threshold <= 1)) {
    throw new InvalidDefinition(
      "resolver",
      resolver.name,
      `has a fuzzy.threshold of ${threshold}, which is not in (0, 1]`,
    );
  }
  // `SET` takes no bind parameters, so the value is interpolated; `toFixed` never produces
  // exponent notation, which is not a numeric literal Postgres accepts here.
  return threshold.toFixed(10);
}

/** Null or missing in any exact key means the row groups with nothing and joins on nothing. */
function exactValues(payload: Payload, keys: readonly string[]): string[] | undefined {
  const values: string[] = [];
  for (const key of keys) {
    const value = payload[key];
    if (value === null || value === undefined) return undefined;
    values.push(String(value));
  }
  return values;
}

/**
 * Links, creates or parks every unlinked `hf_source_record` row of `source`, inside the
 * caller's `ctx.tx`. One call is one batch of at most `limit` rows and one transaction, so a
 * 200k load is many calls: the alternative — one transaction for the whole load — holds
 * `hf_run FOR SHARE` for as long as resolution takes.
 *
 * A row that already carries a link is never re-decided, whatever the link's method: only its
 * record is updated. That is the whole of "a `manual` or `human_confirmed` link is never
 * re-decided" — no method is special-cased, because none has to be.
 *
 * Records resolve one at a time so a later row sees an earlier row's create, and each one runs
 * in its own savepoint: a `create`/`update` that throws marks that row `error` and the batch
 * carries on.
 */
export async function resolveBatch(
  tx: StepDatabase,
  options: ResolveBatchOptions,
): Promise<ResolveBatchResult> {
  const { resolver, table, source } = options;
  const limit = options.limit ?? DEFAULT_RESOLVE_LIMIT;
  const maxAttempts = options.maxAttempts ?? DEFAULT_RESOLVE_MAX_ATTEMPTS;
  const client = (tx as unknown as WithClient).$client;

  const result: ResolveBatchResult = {
    scanned: 0,
    linkedExact: 0,
    linkedFuzzy: 0,
    created: 0,
    updated: 0,
    review: 0,
    error: 0,
    done: true,
  };

  const scanned = await client.query<ScanRow>(SCAN_STATEMENT, [source, maxAttempts, limit]);
  const rows = scanned.rows;
  result.scanned = rows.length;
  if (rows.length === 0) return result;

  const linked = await client.query<{ source_record_id: string; record_id: string }>(
    LINKS_STATEMENT,
    [rows.map((row) => row.id)],
  );
  const existing = new Map(linked.rows.map((row) => [row.source_record_id, row.record_id]));

  const { fuzzy } = resolver;
  if (fuzzy) {
    // Transaction-scoped, so it is set once and survives every ROLLBACK TO SAVEPOINT below.
    await client.query(
      `SET LOCAL pg_trgm.similarity_threshold = ${thresholdLiteral(resolver, fuzzy.threshold)}`,
    );
  }
  const candidateStatement = fuzzy ? fuzzyCandidateStatement(table, fuzzy.field) : undefined;
  const payloadKey = fuzzy?.payloadKey ?? fuzzy?.field;

  const exactStatement =
    resolver.exactKeys.length === 0
      ? undefined
      : `SELECT id FROM ${quoteIdent(table)} WHERE ` +
        resolver.exactKeys.map((key, i) => `${quoteIdent(key)} = $${i + 1}`).join(" AND ") +
        " AND archived_at IS NULL LIMIT 1";

  const link = (id: string, recordId: string, method: string, confidence: number | null) =>
    client.query(INSERT_LINK_STATEMENT, [
      id,
      resolver.recordType,
      recordId,
      confidence,
      method,
    ]);

  const groups = new Map<string, Outcome>();

  for (const row of rows) {
    const recordId = existing.get(row.id);
    const keys = exactValues(row.payload, resolver.exactKeys);
    const groupKey = recordId === undefined && keys ? JSON.stringify(keys) : undefined;
    const leaderOutcome = groupKey === undefined ? undefined : groups.get(groupKey);

    await client.query(`SAVEPOINT ${SAVEPOINT}`);
    try {
      if (recordId !== undefined) {
        await resolver.update(recordId, row.payload, tx);
        await client.query(LINKED_STATEMENT, [row.id]);
        result.updated += 1;
      } else if (leaderOutcome !== undefined) {
        // A duplicate within the batch: the leader already decided this entity, so the
        // follower takes its outcome rather than resolving — and never its own `update`.
        if (leaderOutcome.kind === "record") {
          await link(row.id, leaderOutcome.recordId, "exact", 1);
          await client.query(LINKED_STATEMENT, [row.id]);
          result.linkedExact += 1;
        } else if (leaderOutcome.kind === "review") {
          await client.query(REVIEW_STATEMENT, [row.id]);
          result.review += 1;
        } else {
          throw new Error("the first row of this batch group failed to resolve");
        }
      } else {
        const outcome = await resolveRow(row, keys);
        if (groupKey !== undefined) groups.set(groupKey, outcome);
      }
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      await client.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      await client.query(ERROR_STATEMENT, [row.id, String((error as Error).message ?? error)]);
      result.error += 1;
      if (groupKey !== undefined) groups.set(groupKey, { kind: "error" });
    }
  }

  // A `review` row stays scannable, so a full batch that moved nothing would be handed back
  // identically forever and a `while (!done)` loop would never end. An `error` row counts as
  // movement: its `attempts` climbs towards `maxAttempts`, which does take it out of the scan.
  const moved =
    result.linkedExact + result.linkedFuzzy + result.created + result.updated + result.error;
  result.done = rows.length < limit || moved === 0;
  return result;

  async function resolveRow(row: ScanRow, keys: string[] | undefined): Promise<Outcome> {
    if (exactStatement && keys) {
      const hit = await client.query<{ id: string }>(exactStatement, keys);
      const match = hit.rows[0];
      if (match) {
        await resolver.update(match.id, row.payload, tx);
        await link(row.id, match.id, "exact", 1);
        await client.query(LINKED_STATEMENT, [row.id]);
        result.linkedExact += 1;
        return { kind: "record", recordId: match.id };
      }
    }

    const needle = payloadKey === undefined ? undefined : row.payload[payloadKey];
    if (candidateStatement && typeof needle === "string" && needle !== "") {
      const candidates = await client.query<Record<string, string>>(candidateStatement, [needle]);
      let best: { id: string; score: number } | undefined;
      for (const candidate of candidates.rows) {
        const value = candidate[fuzzy!.field];
        const score = typeof value === "string" ? bigramDice(needle, value) : 0;
        if (!best || score > best.score) best = { id: candidate.id, score };
      }
      if (best) {
        if (resolver.review?.(best.score) === true) {
          await client.query(REVIEW_STATEMENT, [row.id]);
          result.review += 1;
          return { kind: "review" };
        }
        await resolver.update(best.id, row.payload, tx);
        await link(row.id, best.id, "fuzzy", best.score);
        await client.query(LINKED_STATEMENT, [row.id]);
        result.linkedFuzzy += 1;
        return { kind: "record", recordId: best.id };
      }
    }

    const created = await resolver.create(row.payload, tx);
    await link(row.id, created.id, "created", null);
    await client.query(LINKED_STATEMENT, [row.id]);
    result.created += 1;
    return { kind: "record", recordId: created.id };
  }
}
