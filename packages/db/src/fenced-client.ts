import type { Pool, PoolClient, QueryConfig, Submittable } from "pg";
import { classify } from "./classify.js";

export type QueryArg = string | QueryConfig | Submittable;

/**
 * Stands in for a `Submittable` that carries no SQL text of its own. It does not parse, so
 * `classify()` calls it a write.
 */
export const OPAQUE_SUBMITTABLE = "<opaque submittable>";

/**
 * Normalises the three shapes node-pg's `query()` accepts down to the SQL text `classify()` reads.
 * `pg-copy-streams`, `pg-cursor` and `pg-query-stream` all expose their statement as `.text`.
 */
export function extractStatementText(queryArg: QueryArg): string {
  if (typeof queryArg === "string") return queryArg;
  const text = (queryArg as { text?: unknown }).text;
  return typeof text === "string" ? text : OPAQUE_SUBMITTABLE;
}

export class UnfencedWrite extends Error {
  readonly statement: string;

  constructor(statement: string) {
    super(`UnfencedWrite: the step pool refused a write issued outside ctx.tx: ${statement}`);
    this.name = "UnfencedWrite";
    this.statement = statement;
  }
}

/**
 * Drizzle rethrows a driver error as `DrizzleQueryError`, so a refusal that reached the
 * caller through a Drizzle handle is somewhere down the `cause` chain rather than at the top.
 */
export function unfencedWriteOf(error: unknown): UnfencedWrite | undefined {
  let current = error;
  while (current instanceof Error) {
    if (current instanceof UnfencedWrite) return current;
    current = current.cause;
  }
  return undefined;
}

/**
 * The lease that currently holds the tag on a connection, keyed by the underlying
 * `pg.Client`. A lease is minted per checkout, so re-checking out the same connection
 * mints a different one and a handle from an earlier checkout can never match again.
 */
const taggedLease = new WeakMap<PoolClient, symbol>();

const FENCE = Symbol("hyperfixation.fence");

interface Fence {
  readonly client: PoolClient;
  readonly lease: symbol;
}

function fenceOf(client: PoolClient): Fence {
  const fence = (client as { [FENCE]?: Fence })[FENCE];
  if (!fence) throw new TypeError("not a step-pool client");
  return fence;
}

/** Tags a checked-out step-pool client for the life of one `ctx.tx` transaction. */
export function tagForTransaction(client: PoolClient): void {
  const fence = fenceOf(client);
  taggedLease.set(fence.client, fence.lease);
}

function isTagged(fence: Fence): boolean {
  return taggedLease.get(fence.client) === fence.lease;
}

function refuse(args: unknown[], statement: string): undefined {
  const error = new UnfencedWrite(statement);
  const callback = args.find((arg) => typeof arg === "function") as
    | ((err: Error) => void)
    | undefined;
  if (!callback) throw error;
  setImmediate(() => callback(error));
  return undefined;
}

function guard(args: unknown[], tagged: boolean): string | undefined {
  const [first] = args;
  if (typeof first === "function") return undefined;
  const statement = extractStatementText(first as QueryArg);
  return !tagged && classify(statement) === "write" ? statement : undefined;
}

/**
 * Wraps one checkout of a step-pool connection. The wrapper is per-checkout, never shared:
 * that is what makes a handle captured inside `ctx.tx` inert after the transaction ends,
 * whether the connection then sits idle or is re-tagged by a later transaction.
 */
function fenceClient(client: PoolClient): PoolClient {
  const fence: Fence = { client, lease: Symbol("hyperfixation.lease") };
  let released = false;

  // Untagging here rather than in `ctx.tx` makes it structural: no path returns a
  // connection to the pool still carrying this checkout's tag. Idempotent because a refused
  // query also releases (see below) — a caller's own release-in-finally must then be a no-op,
  // not a double-release.
  const release = (err?: Error | boolean): void => {
    if (released) return;
    released = true;
    if (isTagged(fence)) taggedLease.delete(fence.client);
    client.release(err);
  };

  const query = (...args: unknown[]): unknown => {
    const refused = guard(args, isTagged(fence));
    if (refused !== undefined) {
      // A refused statement never reaches the real connection, so it is always safe to hand
      // straight back here. Without this, Drizzle's own `db.transaction()` leaks a checkout on
      // every refusal: it checks a client out and issues `BEGIN` before opening the try/finally
      // that would otherwise release it, so a refusal here would strand the connection forever.
      release();
      return refuse(args, refused);
    }
    return (client.query as (...a: unknown[]) => unknown).apply(client, args);
  };

  return new Proxy(client, {
    get(target, property) {
      if (property === FENCE) return fence;
      if (property === "query") return query;
      if (property === "release") return release;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as PoolClient;
}

/**
 * Turns `pool` into the step pool by patching the instance — node-pg has no plugin hook,
 * and patching the `pg` module would fence the control pool too. Every statement that is
 * not a pure `SELECT` is refused with `UnfencedWrite` unless the specific connection it
 * runs on is currently tagged by `ctx.tx`. No async context is consulted.
 *
 * What it does not stop, deliberately: the pool still hands the raw client to `'acquire'`,
 * `'connect'`, `'release'` and `'remove'` listeners, and still carries its own
 * `options.connectionString`. Those are bypasses someone has to reach for; the fence exists
 * for the shapes that look like ordinary code.
 */
export function fencePool(pool: Pool): Pool {
  const poolQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  const poolConnect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;

  pool.query = ((...args: unknown[]): unknown => {
    // `pool.query` checks a connection out and returns it within the one call, so it can
    // never be inside `ctx.tx`; refusing before `connect()` keeps a refusal free.
    const refused = guard(args, false);
    if (refused !== undefined) return refuse(args, refused);
    return poolQuery(...args);
  }) as Pool["query"];

  pool.connect = ((callback?: unknown): unknown => {
    if (typeof callback !== "function") {
      return (poolConnect() as Promise<PoolClient>).then(fenceClient);
    }
    return poolConnect((err: Error | undefined, client: PoolClient | undefined) => {
      if (err || !client) return callback(err, client, undefined);
      const fenced = fenceClient(client);
      return callback(undefined, fenced, fenced.release);
    });
  }) as Pool["connect"];

  return pool;
}
