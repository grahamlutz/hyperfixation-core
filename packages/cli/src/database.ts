import { isIPv4 } from "node:net";
import { Client } from "pg";
import { shellQuote, TUNNEL_LOOPBACK, type Runner, type Tunnel } from "./runner.js";

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
 * Its far end is the box's loopback where the port is published and the container's own address
 * on the docker network where it is not. `docker-exec` is the last resort: it runs the same SQL
 * through `psql` inside the container, so `CREATE DATABASE`, the extensions and a password
 * rotation all work, but there is no address for a client library to dial and `adminUrl` is
 * `undefined`.
 */
export interface Database {
  readonly kind: DatabaseTransport;
  /**
   * Where the **box** reaches this cluster, for anything that runs there rather than here —
   * `pg_restore`, in E7. `undefined` when the transport has no address at all.
   */
  readonly boxAddress?: { host: string; port: number };
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
  /** The port Postgres listens on, wherever it is reached. */
  remotePort?: number;
  /**
   * What the Coolify Postgres container may be called, in the order to try them; Coolify's own
   * naming depends on how the database was created. The address of the first one that exists is
   * what the tunnel forwards to when the box's loopback has no listener, and `dockerExec` runs
   * `psql` inside it. Omit to have neither, and the loopback is then the only route.
   */
  containers?: readonly string[];
  /** Last resort when no address carries a query: `psql` inside the container. Default false. */
  dockerExec?: boolean;
}

export const DEFAULT_POSTGRES_PORT = 5432;
const DEFAULT_ADMIN_DATABASE = "postgres";

/**
 * Docker's network→IP map for one container, as whitespace-separated `network=ip` pairs.
 *
 * A Go template rather than `--format json` and a parse: the output is one flat line, so nothing
 * about it depends on which docker version the box has.
 */
const DOCKER_NETWORKS_FORMAT =
  "{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}";

/** The network Coolify attaches its services to, and the one the box host can route to. */
const COOLIFY_NETWORK = "coolify";

/**
 * Opens the cluster over `runner`: the box's loopback, else the container, else `docker exec`.
 *
 * Coolify publishes nothing for its Postgres — `docker inspect` reports `{"5432/tcp": null}`, so
 * the box's `127.0.0.1:5432` is not a listener and forwarding to it can never work. The
 * container's address on the `coolify` network is the route in: the box host routes to it, and
 * `ssh -L localPort:<containerIP>:5432` makes the box the hop. Publishing the port would bind
 * every interface, which is not a trade worth making for a forward that already works.
 *
 * The loopback is still tried first and costs one `ssh` when it fails, because some setups do
 * publish it. Each probe is a real `SELECT 1` rather than a port check: an `ssh -L` forward
 * accepts locally and only then discovers that nothing is listening on the far side, so a forward
 * to an unpublished port looks healthy until the first query.
 */
export async function openDatabase(
  runner: Runner,
  options: OpenDatabaseOptions,
): Promise<Database> {
  const remotePort = options.remotePort ?? DEFAULT_POSTGRES_PORT;

  const loopback = await tryTunnel(runner, options.admin, remotePort, TUNNEL_LOOPBACK);
  if ("database" in loopback) return loopback.database;

  const candidates = options.containers ?? [];
  if (candidates.length === 0) {
    throw new DatabaseTransportError(
      "tunnel",
      `could not reach Postgres on ${TUNNEL_LOOPBACK}:${String(remotePort)} on the box, and no ` +
        "container was named to discover an address on the docker network",
      { cause: loopback.failure },
    );
  }

  const found = await containerAddress(runner, candidates);
  const direct = await tryTunnel(runner, options.admin, remotePort, found.address);
  if ("database" in direct) return direct.database;

  if (options.dockerExec !== true) {
    throw new DatabaseTransportError(
      "tunnel",
      `could not reach Postgres on ${TUNNEL_LOOPBACK}:${String(remotePort)} on the box, nor on ` +
        `${found.address}:${String(remotePort)}, which is where ${found.container} answers on ` +
        "the docker network",
      { cause: direct.failure },
    );
  }
  return dockerExecDatabase(runner, found.container, options.admin);
}

/** The cluster at a URL this process can already dial — a test's Postgres, or a live tunnel. */
export function openDatabaseUrl(adminUrl: string): Database {
  return tunnelDatabase(adminUrl, undefined, undefined);
}

type TunnelAttempt = { database: Database } | { failure: unknown };

async function tryTunnel(
  runner: Runner,
  admin: AdminCredentials,
  remotePort: number,
  remoteHost: string,
): Promise<TunnelAttempt> {
  let tunnel: Tunnel | undefined;
  try {
    tunnel = await runner.tunnel(remotePort, remoteHost);
    const database = tunnelDatabase(adminUrlOf(admin, tunnel.localPort), tunnel, {
      host: remoteHost,
      port: remotePort,
    });
    await database.query("SELECT 1");
    return { database };
  } catch (failure) {
    await tunnel?.close();
    return { failure };
  }
}

/**
 * The first of `containers` that exists, and its own address, asked of the box.
 *
 * The `coolify` network by name, because a Coolify service also sits on a per-service network
 * that only its own stack is on; the first address is the fallback for a box that names its
 * network something else. Every candidate that failed is reported, because which name a database
 * got is a fact about how it was created and the operator is the one who knows it.
 */
async function containerAddress(
  runner: Runner,
  containers: readonly string[],
): Promise<{ container: string; address: string }> {
  const problems: string[] = [];
  for (const container of containers) {
    const command = ["docker", "inspect", "-f", DOCKER_NETWORKS_FORMAT, container];
    const result = await runner.exec(command);
    if (result.code !== 0) {
      problems.push(
        `${container}: ${shellQuote(command)} exited ${String(result.code)}: ` +
          result.stderr.trim(),
      );
      continue;
    }

    const address = coolifyAddress(result.stdout);
    if (address === undefined) {
      problems.push(
        `${container}: no IPv4 address on any docker network, ${shellQuote(command)} printed ` +
          JSON.stringify(result.stdout.trim()),
      );
      continue;
    }
    return { container, address };
  }

  throw new DatabaseTransportError(
    "tunnel",
    `no Postgres container on the box under any name tried (${containers.join(", ")}): ` +
      problems.join("; "),
  );
}

/** The `coolify` network's address in `docker inspect`'s output, else the first one there is. */
function coolifyAddress(stdout: string): string | undefined {
  const networks = stdout
    .split(/\s+/)
    .filter((pair) => pair.includes("="))
    .map((pair) => ({
      network: pair.slice(0, pair.indexOf("=")),
      address: pair.slice(pair.indexOf("=") + 1),
    }))
    // An IPv4 literal and nothing else: this goes into an `ssh -L` field, and a container with no
    // address on a network reports the key with an empty value.
    .filter((entry) => isIPv4(entry.address));

  return (networks.find((entry) => entry.network === COOLIFY_NETWORK) ?? networks[0])?.address;
}

function tunnelDatabase(
  adminUrl: string,
  tunnel: Tunnel | undefined,
  boxAddress: { host: string; port: number } | undefined,
): Database {
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
    boxAddress,
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
