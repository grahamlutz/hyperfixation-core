import { createHash } from "node:crypto";
import type { StepContext } from "@hyperfixation/workflows";
import { stepClient } from "./step-client.js";

/** A day, the interval a collector's fixture or a listing page is worth re-reading on. */
export const DEFAULT_FETCH_TTL_MS = 24 * 60 * 60 * 1000;

/** One request per second per host, until a row in `hf_fetch_domain` says otherwise. */
export const DEFAULT_FETCH_MIN_INTERVAL_MS = 1000;

/** 5 MB. A response over the cap is refused rather than stored: `hf_raw_fetch.body` is a column. */
export const FETCH_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

/**
 * The cache read, unlocked: a hit inside `expires_at` is the whole call, so the common path
 * costs one round trip and takes no advisory lock.
 */
export const FETCH_CACHED_STATEMENT =
  "SELECT id, url, method, status, headers, body, content_type, etag, error, fetched_at, expires_at " +
  "FROM hf_raw_fetch WHERE url_hash = $1 AND method = $2 AND expires_at > clock_timestamp()";

/**
 * What serializes every worker reaching one host. Transaction-scoped, so the commit that writes
 * the row releases it and there is no unlock to leak on a throw.
 */
export const FETCH_DOMAIN_LOCK_STATEMENT =
  "SELECT pg_advisory_xact_lock(hashtext('hf-fetch:' || $1::text))";

/**
 * The bound on queueing behind another worker's turn at one host. The holder keeps the lock across
 * a request, so a process killed mid-fetch leaves its transaction idle until something reaps the
 * connection — and without a bound every other worker wanting that host would queue behind it
 * until then, which is one wedged host starving the whole step pool.
 */
export const FETCH_LOCK_TIMEOUT_MS = 60_000;

/**
 * `SET LOCAL`, so the bound lapses with the transaction that takes the lock, and `55P03` fails the
 * one step rather than the worker. A legitimate holder waits out the host's interval before it
 * fetches, so the bound clears twice that: a host deliberately spaced further apart than
 * `FETCH_LOCK_TIMEOUT_MS` must still be waited for rather than timed out on.
 */
export function fetchLockTimeoutStatement(minIntervalMs: number): string {
  const interval = Number.isFinite(minIntervalMs) ? Math.max(0, Math.ceil(minIntervalMs)) : 0;
  const ms = Math.max(FETCH_LOCK_TIMEOUT_MS, interval * 2);
  return `SET LOCAL lock_timeout = '${String(ms)}ms'`;
}

export const FETCH_DOMAIN_UPSERT_STATEMENT =
  "INSERT INTO hf_fetch_domain (domain, min_interval_ms) VALUES ($1, $2) " +
  "ON CONFLICT (domain) DO NOTHING";

/**
 * How long this call still owes the host. `clock_timestamp()` rather than `now()`: the fetching
 * transaction is already open, so `now()` is its start and every wait after the first would be
 * computed against a stale reading. A host never reached yields NULL, which is no wait.
 */
export const FETCH_DOMAIN_WAIT_STATEMENT =
  "SELECT COALESCE(GREATEST(0, min_interval_ms - " +
  "EXTRACT(EPOCH FROM (clock_timestamp() - last_fetched_at)) * 1000), 0)::bigint AS wait_ms " +
  "FROM hf_fetch_domain WHERE domain = $1";

/** Stamped before the request, so the interval spaces request *starts* rather than finishes. */
export const FETCH_DOMAIN_STAMP_STATEMENT =
  "UPDATE hf_fetch_domain SET last_fetched_at = clock_timestamp() WHERE domain = $1";

export const FETCH_WRITE_STATEMENT =
  "INSERT INTO hf_raw_fetch " +
  "(url, url_hash, method, status, headers, body, content_type, etag, error, fetched_at, expires_at, run_id) " +
  "VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, clock_timestamp(), " +
  "clock_timestamp() + make_interval(secs => $10::double precision), $11) " +
  "ON CONFLICT (url_hash, method) DO UPDATE SET " +
  "url = EXCLUDED.url, status = EXCLUDED.status, headers = EXCLUDED.headers, body = EXCLUDED.body, " +
  "content_type = EXCLUDED.content_type, etag = EXCLUDED.etag, error = EXCLUDED.error, " +
  "fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at, run_id = EXCLUDED.run_id " +
  "RETURNING id, url, method, status, headers, body, content_type, etag, error, fetched_at, expires_at";

/**
 * No `key`: unlike `llm.run` and `actions.perform`, which key a ledger row by the step that
 * wrote it, this row is keyed by `(url_hash, method)` — the cache is shared across runs, which
 * is the whole point of it — so a second key would name nothing.
 */
export interface FetchGetOptions {
  url: string;
  /** How long the stored response answers for; defaults to `DEFAULT_FETCH_TTL_MS`. */
  ttlMs?: number;
  headers?: Record<string, string>;
  /** Only the two bodyless-cacheable verbs; defaults to `GET`. */
  method?: "GET" | "HEAD";
  /** The interval a host unknown to `hf_fetch_domain` is entered with. */
  minIntervalMs?: number;
}

/** One `hf_raw_fetch` row, as `fetch.get` returns it. */
export interface RawFetch {
  id: number;
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  /** Null for a `HEAD`, or for a response that carried none. */
  body: Buffer | null;
  contentType: string | null;
  etag: string | null;
  fetchedAt: Date;
  expiresAt: Date;
  /** True when no request was made: the row was already inside its TTL. */
  cached: boolean;
}

export class FetchTooLarge extends Error {
  readonly url: string;
  readonly limitBytes: number;
  /** What the response declared, or what it had reached when it was abandoned. */
  readonly bytes: number;

  constructor(url: string, bytes: number, limitBytes: number) {
    super(
      `FetchTooLarge: ${url} returned at least ${bytes} bytes, over the ${limitBytes}-byte cap ` +
        "on hf_raw_fetch.body; the refusal is cached, so the body is not fetched again until it " +
        "expires",
    );
    this.name = "FetchTooLarge";
    this.url = url;
    this.limitBytes = limitBytes;
    this.bytes = bytes;
  }
}

interface FetchRow extends Record<string, unknown> {
  id: string;
  url: string;
  method: string;
  status: number;
  headers: Record<string, string> | null;
  body: Buffer | null;
  content_type: string | null;
  etag: string | null;
  error: string | null;
  fetched_at: Date;
  expires_at: Date;
}

/** The response, split from its body so a refusal still knows the status it was refusing. */
interface Head {
  status: number;
  headers: Record<string, string>;
  contentType: string | null;
  etag: string | null;
}

type Taken =
  | { row: FetchRow; cached: boolean; refused?: undefined }
  | { refused: Error; row?: undefined; cached?: undefined };

/** The unique key is over a hash because a URL has no length bound and a btree entry does. */
export function urlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

/** The politeness bucket: the host without its port, so one site is one budget. */
export function fetchDomainOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/**
 * One cached HTTP GET, called from inside a `step()` body.
 *
 * A hit inside `expires_at` returns the stored row and makes no request. A miss takes
 * `pg_advisory_xact_lock(hashtext('hf-fetch:' || domain))`, waits out whatever the host's
 * `min_interval_ms` still owes, fetches, and writes the row — all in one `ctx.tx`, because the
 * lock is transaction-scoped and releasing it before the request would let two workers hit the
 * host together. This is the one place the package holds a transaction across a network call,
 * and the body cap is what bounds how long: an oversized body is abandoned, not read to the end.
 * Waiting *for* the lock is bounded separately, by `fetchLockTimeoutStatement`.
 *
 * A body over `FETCH_BODY_LIMIT_BYTES` writes an error row and throws `FetchTooLarge`, and a hit
 * on that row throws again without a request — a URL that was too big stays too big, and
 * re-downloading it to rediscover that is what the cap exists to prevent.
 */
export async function fetchGet(ctx: StepContext, options: FetchGetOptions): Promise<RawFetch> {
  const method = options.method ?? "GET";
  const hash = urlHash(options.url);
  const domain = fetchDomainOf(options.url);
  const ttlMs = options.ttlMs ?? DEFAULT_FETCH_TTL_MS;
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_FETCH_MIN_INTERVAL_MS;

  const hit = await ctx.tx((db) => cached(stepClient(db), hash, method));
  if (hit !== undefined) return resultOf(hit, true);

  const taken = await ctx.tx<Taken>(async (db) => {
    const pg = stepClient(db);
    await pg.query(fetchLockTimeoutStatement(minIntervalMs));
    await pg.query(FETCH_DOMAIN_LOCK_STATEMENT, [domain]);
    // Whoever held the lock may have filled this very URL while we waited behind them.
    const filled = await cached(pg, hash, method);
    if (filled !== undefined) return { row: filled, cached: true };

    await pg.query(FETCH_DOMAIN_UPSERT_STATEMENT, [domain, minIntervalMs]);
    const wait = await pg.query<{ wait_ms: string }>(FETCH_DOMAIN_WAIT_STATEMENT, [domain]);
    const waitMs = Number(wait.rows[0]!.wait_ms);
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    // A throw below rolls this back with the rest, which is right: nothing reached the host.
    await pg.query(FETCH_DOMAIN_STAMP_STATEMENT, [domain]);

    const response = await globalThis.fetch(options.url, { method, headers: options.headers });
    const head: Head = {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      contentType: response.headers.get("content-type"),
      etag: response.headers.get("etag"),
    };

    let body: Buffer | null = null;
    let refusal: FetchTooLarge | undefined;
    try {
      body = method === "HEAD" ? null : await readCapped(response, options.url);
    } catch (error) {
      if (!(error instanceof FetchTooLarge)) throw error;
      refusal = error;
    }

    const written = await pg.query<FetchRow>(FETCH_WRITE_STATEMENT, [
      options.url,
      hash,
      method,
      head.status,
      JSON.stringify(head.headers),
      body,
      head.contentType,
      head.etag,
      refusal?.message ?? null,
      ttlMs / 1000,
      ctx.runId,
    ]);
    // Returned rather than thrown: `ctx.tx` rolls back on anything thrown inside it, and the
    // error row is the whole point of this branch — as `actions.perform` does with `uncertain`.
    if (refusal !== undefined) return { refused: refusal };
    return { row: written.rows[0]!, cached: false };
  });

  if (taken.refused !== undefined) throw taken.refused;
  return resultOf(taken.row, taken.cached);
}

/** `fetch.get(…)`, the name the plan and every flow use. */
export const fetch = { get: fetchGet };

async function cached(
  pg: ReturnType<typeof stepClient>,
  hash: string,
  method: string,
): Promise<FetchRow | undefined> {
  const { rows } = await pg.query<FetchRow>(FETCH_CACHED_STATEMENT, [hash, method]);
  return rows[0];
}

/**
 * The body, or `FetchTooLarge`. `Content-Length` is checked first so a declared oversize costs
 * no transfer at all, and the stream is abandoned the moment the running total passes the cap —
 * `response.bytes()` would buffer all 6 MB before anyone could refuse it.
 */
async function readCapped(response: Response, url: string): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > FETCH_BODY_LIMIT_BYTES) {
    abandon(response.body);
    throw new FetchTooLarge(url, declared, FETCH_BODY_LIMIT_BYTES);
  }
  if (response.body === null) return null;

  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > FETCH_BODY_LIMIT_BYTES) {
      abandon(reader);
      throw new FetchTooLarge(url, bytes, FETCH_BODY_LIMIT_BYTES);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Releases the rest of a body nobody is going to read. Never awaited: the refusal is already
 * decided, and msw's node interceptor never settles the `cancel()` of a body it is serving — a
 * wait here would hang the whole call inside the transaction, which is the worst place for it.
 */
function abandon(stream: { cancel(): Promise<void> } | null): void {
  void stream?.cancel().catch(() => undefined);
}

/**
 * An error row revives as a plain `Error` carrying the stored message and name, the same way
 * `llm.run` revives a stored provider error: the byte count is in the message, not a column,
 * and inventing a `FetchTooLarge` with a made-up `bytes` would be worse than not having one.
 */
function resultOf(row: FetchRow, wasCached: boolean): RawFetch {
  if (row.error !== null) {
    const error = new Error(row.error);
    error.name = "FetchTooLarge";
    throw error;
  }
  return {
    id: Number(row.id),
    url: row.url,
    method: row.method,
    status: row.status,
    headers: row.headers ?? {},
    body: row.body,
    contentType: row.content_type,
    etag: row.etag,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    cached: wasCached,
  };
}
