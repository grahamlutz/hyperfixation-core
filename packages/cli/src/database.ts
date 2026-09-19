import { Client } from "pg";
import type { Runner, Tunnel } from "./runner.js";

/** Rows as strings, the one shape both transports can produce without inventing types. */
export interface QueryResult {
  rows: string[][];
}

export interface QueryOptions {
  /** Which database on the cluster to run against; defaults to the admin database. */
  database?: string;
}

export type DatabaseTransport = "tunnel" | "docker-exec";

/**
 * One way of reaching the box's Postgres cluster as an admin.
 *
 * `tunnel` is the default, and the only transport that can carry the whole of E2: it hands out
 * a libpq URL, which is what `provisionRoles()` — a `pg` client, in `@hyperfixation/db` — takes.
 * `docker-exec` exists because Phase 0 never confirmed that the Coolify Postgres container
 * publishes 5432 on the box's loopback; it runs the same SQL through `psql` inside the
 * container, so `CREATE DATABASE`, the extensions and a password rotation all work, but there
 * is no address for a client library to dial and `adminUrl` is `undefined`.
 */
export interface Database {
  readonly kind: DatabaseTransport;
  /** A libpq URL onto `databaseName`, or `undefined` when the transport has no address. */
  adminUrl(databaseName?: string): string | undefined;
  query(sql: string, options?: QueryOptions): Promise<QueryResult>;
  close(): Promise<void>;
}

export class DatabaseTransportError extends Error {
  readonly transport: DatabaseTransport;

  constructor(transport: DatabaseTransport, message: string, options?: { cause?: unknown }) {
    super(`${transport}: ${message}`, options);
    this.name = "DatabaseTransportError";
    this.transport = transport;
  }
}

/**
 * Blanks anything that looks like a password before it reaches a message.
 *
 * `psql` echoes the failing statement, and the failing statement is sometimes an `ALTER ROLE
 * … PASSWORD`; a connection string carries one in its authority. Neither may reach a terminal
 * or a scrollback, so every transport error goes through here on the way out.
 */
export function redactPasswords(text: string): string {
  return text
    .replace(/(PASSWORD\s+)'(?:[^']|'')*'/gi, "$1'***'")
    .replace(/(:\/\/[^:@/\s]+):[^@/\s]+@/g, "$1:***@");
}

/** Separates the columns of a `psql -A` row; no SQL value this provisions can contain it. */
const FIELD_SEPARATOR = "";

export interface AdminCredentials {
  user: string;
  password?: string;
  /** The database to connect to for cluster-wide statements. Defaults to `postgres`. */
  database?: string;
}

export interface OpenDatabaseOptions {
  admin: AdminCredentials;
  /** Where Postgres listens on the box's loopback. */
  remotePort?: number;
  /** The Coolify Postgres container, for the `docker-exec` fallback. Omit to have none. */
  container?: string;
}

export const DEFAULT_POSTGRES_PORT = 5432;
const DEFAULT_ADMIN_DATABASE = "postgres";

/**
 * Opens the cluster over `runner`, preferring the tunnel and falling back to `docker exec`.
 *
 * The probe is a real `SELECT 1` rather than a port check: an `ssh -L` forward accepts locally
 * and only then discovers that nothing is listening on the far side, so a forward to an
 * unpublished port looks healthy until the first query.
 */
export async function openDatabase(
  runner: Runner,
  options: OpenDatabaseOptions,
): Promise<Database> {
  const remotePort = options.remotePort ?? DEFAULT_POSTGRES_PORT;

  let tunnel: Tunnel | undefined;
  try {
    tunnel = await runner.tunnel(remotePort);
    const database = tunnelDatabase(adminUrlOf(options.admin, tunnel.localPort), tunnel);
    await database.query("SELECT 1");
    return database;
  } catch (cause) {
    await tunnel?.close();
    if (options.container === undefined) {
      throw new DatabaseTransportError(
        "tunnel",
        `could not reach Postgres on 127.0.0.1:${String(remotePort)} on the box, and no ` +
          "container was named to fall back to",
        { cause },
      );
    }
  }

  return dockerExecDatabase(runner, options.container, options.admin);
}

/** The cluster at a URL this process can already dial — a test's Postgres, or a live tunnel. */
export function openDatabaseUrl(adminUrl: string): Database {
  return tunnelDatabase(adminUrl, undefined);
}

function tunnelDatabase(adminUrl: string, tunnel: Tunnel | undefined): Database {
  const clients = new Map<string, Client>();

  const clientFor = async (databaseName: string | undefined): Promise<Client> => {
    const url = withDatabase(adminUrl, databaseName);
    const existing = clients.get(url);
    if (existing !== undefined) return existing;
    const client = new Client({ connectionString: url });
    await client.connect();
    clients.set(url, client);
    return client;
  };

  return {
    kind: "tunnel",
    adminUrl: (databaseName) => withDatabase(adminUrl, databaseName),
    query: async (sql, queryOptions) => {
      const client = await clientFor(queryOptions?.database);
      try {
        const result = await client.query({ text: sql, rowMode: "array" });
        const rows = (result.rows as unknown[][] | undefined) ?? [];
        return { rows: rows.map((row) => row.map(String)) };
      } catch (cause) {
        throw new DatabaseTransportError("tunnel", redactPasswords((cause as Error).message), {
          cause,
        });
      }
    },
    close: async () => {
      for (const client of clients.values()) await client.end();
      clients.clear();
      await tunnel?.close();
    },
  };
}

function dockerExecDatabase(
  runner: Runner,
  container: string,
  admin: AdminCredentials,
): Database {
  return {
    kind: "docker-exec",
    adminUrl: () => undefined,
    query: async (sql, queryOptions) => {
      // `-f -`: the statement goes down stdin, so it never appears in the box's process list
      // and never has to survive a second round of shell quoting.
      const result = await runner.exec(
        [
          "docker",
          "exec",
          "-i",
          container,
          "psql",
          "-v",
          "ON_ERROR_STOP=1",
          "-qtAF",
          FIELD_SEPARATOR,
          "-U",
          admin.user,
          "-d",
          queryOptions?.database ?? admin.database ?? DEFAULT_ADMIN_DATABASE,
          "-f",
          "-",
        ],
        { input: sql },
      );
      if (result.code !== 0) {
        throw new DatabaseTransportError(
          "docker-exec",
          `psql exited ${String(result.code)}: ${redactPasswords(result.stderr.trim())}`,
        );
      }
      const rows = result.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => line.split(FIELD_SEPARATOR));
      return { rows };
    },
    close: async () => undefined,
  };
}

function adminUrlOf(admin: AdminCredentials, localPort: number): string {
  const url = new URL("postgresql://127.0.0.1");
  url.port = String(localPort);
  url.username = encodeURIComponent(admin.user);
  if (admin.password !== undefined) url.password = encodeURIComponent(admin.password);
  url.pathname = `/${encodeURIComponent(admin.database ?? DEFAULT_ADMIN_DATABASE)}`;
  return url.toString();
}

function withDatabase(connectionString: string, databaseName: string | undefined): string {
  if (databaseName === undefined) return connectionString;
  const url = new URL(connectionString);
  url.pathname = `/${encodeURIComponent(databaseName)}`;
  return url.toString();
}
