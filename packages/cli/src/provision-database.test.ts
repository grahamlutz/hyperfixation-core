import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ADMIN_URL, asRole } from "@hyperfixation/testing";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  openDatabase,
  openDatabaseUrl,
  redactPasswords,
  type Database,
  type QueryOptions,
} from "./database.js";
import { InvalidAppName } from "./names.js";
import { provisionDatabase, ProvisionDatabaseError } from "./provision-database.js";
import type { ExecResult, Runner } from "./runner.js";
import { openAppState, type AppStateStore } from "./state.js";

const provisioned: string[] = [];
const tempDirs: string[] = [];

/** A fresh app name per test; the cluster is shared with every other suite. */
function appName(): string {
  const name = `cli_e2_${randomBytes(4).toString("hex")}`;
  provisioned.push(name);
  return name;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hf-provision-"));
  tempDirs.push(dir);
  return dir;
}

async function connects(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

function roleUrl(role: string, password: string, databaseName: string): string {
  const url = new URL(ADMIN_URL);
  url.username = role;
  url.password = password;
  url.pathname = `/${encodeURIComponent(databaseName)}`;
  return url.toString();
}

function adminUrlFor(databaseName: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${encodeURIComponent(databaseName)}`;
  return url.toString();
}

/** Every statement `provisionDatabase` puts through the transport, in order. */
function recording(inner: Database): Database & { statements: string[] } {
  const statements: string[] = [];
  return {
    statements,
    kind: inner.kind,
    adminUrl: (databaseName?: string) => inner.adminUrl(databaseName),
    query: async (sql: string, options?: QueryOptions) => {
      statements.push(sql);
      return await inner.query(sql, options);
    },
    close: async () => await inner.close(),
  };
}

async function stateIn(dir: string, name: string): Promise<AppStateStore> {
  return await openAppState(name, { dir });
}

afterAll(async () => {
  await asRole(ADMIN_URL, async (admin) => {
    for (const name of provisioned) {
      await admin.query(`DROP DATABASE IF EXISTS "hf_${name}" WITH (FORCE)`);
      for (const suffix of ["", "_migrator", "_ro"]) {
        await admin.query(`DROP ROLE IF EXISTS "hf_${name}${suffix}"`);
      }
    }
  });
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
}, 60_000);

describe("provisionDatabase", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await tempDir();
  });

  it("creates the database, its extensions and three roles with limits null/25/4", async () => {
    const name = appName();
    const state = await stateIn(dir, name);

    const result = await provisionDatabase(ADMIN_URL, { app: name, state });

    expect(result).toMatchObject({
      databaseName: `hf_${name}`,
      createdDatabase: true,
      alreadyDone: false,
      rotated: false,
    });

    await asRole(ADMIN_URL, async (admin) => {
      const { rows } = await admin.query<{ rolname: string; rolconnlimit: number }>(
        "SELECT rolname, rolconnlimit FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname",
        [[result.roles.migrator, result.roles.application, result.roles.readonly]],
      );
      expect(rows).toEqual([
        { rolname: result.roles.application, rolconnlimit: 25 },
        { rolname: result.roles.migrator, rolconnlimit: -1 },
        { rolname: result.roles.readonly, rolconnlimit: 4 },
      ]);
    });

    await asRole(adminUrlFor(result.databaseName), async (client) => {
      const { rows } = await client.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = ANY($1::text[]) ORDER BY extname",
        [["pg_trgm", "vector"]],
      );
      expect(rows.map((row) => row.extname)).toEqual(["pg_trgm", "vector"]);
    });

    expect(state.isDone("database")).toBe(true);
    const stored = state.state.database!;
    expect(
      await connects(roleUrl(result.roles.application, stored.applicationPassword!, result.databaseName)),
    ).toBe(true);
  }, 60_000);

  it("re-runs as a no-op: not one statement, and no role touched", async () => {
    const name = appName();
    const first = await provisionDatabase(ADMIN_URL, { app: name, state: await stateIn(dir, name) });

    // A limit provisionRoles would overwrite: if it ran again, 7 would be 25.
    await asRole(ADMIN_URL, async (admin) => {
      await admin.query(`ALTER ROLE "${first.roles.application}" CONNECTION LIMIT 7`);
    });

    const db = recording(openDatabaseUrl(ADMIN_URL));
    try {
      const again = await provisionDatabase(db, { app: name, state: await stateIn(dir, name) });
      expect(again).toMatchObject({ alreadyDone: true, createdDatabase: false, rotated: false });
      expect(db.statements).toEqual([]);
    } finally {
      await db.close();
    }

    await asRole(ADMIN_URL, async (admin) => {
      const { rows } = await admin.query<{ rolconnlimit: number }>(
        "SELECT rolconnlimit FROM pg_roles WHERE rolname = $1",
        [first.roles.application],
      );
      expect(rows[0]?.rolconnlimit).toBe(7);
    });
  }, 60_000);

  it("rotates on a cold run: the new application password works, the old one no longer does", async () => {
    const name = appName();
    const warm = await stateIn(dir, name);
    const first = await provisionDatabase(ADMIN_URL, { app: name, state: warm });
    const oldPassword = warm.state.database!.applicationPassword!;

    const cold = await stateIn(await tempDir(), name);
    const second = await provisionDatabase(ADMIN_URL, { app: name, state: cold });

    expect(second.rotated).toBe(true);
    const newPassword = cold.state.database!.applicationPassword!;
    expect(newPassword).not.toBe(oldPassword);
    expect(await connects(roleUrl(first.roles.application, newPassword, first.databaseName))).toBe(
      true,
    );
    expect(await connects(roleUrl(first.roles.application, oldPassword, first.databaseName))).toBe(
      false,
    );
  }, 60_000);

  it("converges after a crash between the database change and the state write", async () => {
    const name = appName();
    const store = await stateIn(dir, name);
    const crashing: AppStateStore = {
      ...store,
      get state() {
        return store.state;
      },
      patch: async () => {
        throw new Error("crash: the laptop went away between ALTER ROLE and the state write");
      },
    };

    await expect(provisionDatabase(ADMIN_URL, { app: name, state: crashing })).rejects.toThrow(
      /crash/,
    );
    // The invariant the order buys: nothing was written, so the file cannot name a password the
    // cluster has never heard of.
    expect(store.state.database).toBeUndefined();
    expect(store.isDone("database")).toBe(false);

    const next = await stateIn(dir, name);
    const result = await provisionDatabase(ADMIN_URL, { app: name, state: next });

    expect(result.rotated).toBe(true);
    expect(next.isDone("database")).toBe(true);
    expect(
      await connects(
        roleUrl(result.roles.application, next.state.database!.applicationPassword!, result.databaseName),
      ),
    ).toBe(true);
  }, 60_000);

  it("refuses an app name carrying shell metacharacters before it touches the cluster", async () => {
    const state = await stateIn(dir, "bad");

    await expect(
      provisionDatabase(ADMIN_URL, { app: "demo'; DROP DATABASE postgres; --", state }),
    ).rejects.toThrow(InvalidAppName);
  });

  it("refuses to provision roles over the docker-exec transport, which has no address", async () => {
    const name = appName();
    const state = await stateIn(dir, name);
    const db: Database = {
      kind: "docker-exec",
      adminUrl: () => undefined,
      query: async () => ({ rows: [] }),
      close: async () => undefined,
    };

    await expect(provisionDatabase(db, { app: name, state })).rejects.toThrow(
      ProvisionDatabaseError,
    );
  });
});

describe("the cluster transports", () => {
  /** What Coolify may call the box's Postgres container, and its address on the `coolify` network. */
  const CONTAINERS = ["4pjq0kw7ty27vsi0xpesevrq", "postgresql-4pjq0kw7ty27vsi0xpesevrq"];
  const CONTAINER_IP = "10.0.1.9";
  const inspectArgv = (container: string): string[] => [
    "docker",
    "inspect",
    "-f",
    "{{range $k,$v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}",
    container,
  ];

  const cluster = new URL(ADMIN_URL);
  const clusterPort = Number(cluster.port === "" ? "5432" : cluster.port);
  const clusterAdmin = {
    user: decodeURIComponent(cluster.username),
    password: decodeURIComponent(cluster.password),
  };

  /** Forwards land on the test cluster for the hosts in `live`, and on nothing for any other. */
  function forwarder(live: Record<string, number>, targets: string[]): Runner["tunnel"] {
    return async (remotePort, remoteHost = "127.0.0.1") => {
      targets.push(`${remoteHost}:${String(remotePort)}`);
      return { localPort: live[remoteHost] ?? (await deadPort()), close: async () => undefined };
    };
  }

  it("takes the box's loopback when Postgres answers there, and asks docker nothing", async () => {
    const targets: string[] = [];
    const commands: string[][] = [];
    const runner: Runner = {
      exec: async (command): Promise<ExecResult> => {
        commands.push([...command]);
        return { code: 0, stdout: "", stderr: "" };
      },
      tunnel: forwarder({ "127.0.0.1": clusterPort }, targets),
    };

    const db = await openDatabase(runner, { admin: clusterAdmin, containers: CONTAINERS });

    try {
      expect(db.kind).toBe("tunnel");
      expect(db.boxAddress).toEqual({ host: "127.0.0.1", port: 5432 });
      expect(targets).toEqual(["127.0.0.1:5432"]);
      expect(commands).toEqual([]);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("forwards to the container's coolify address when the loopback refuses", async () => {
    const targets: string[] = [];
    const commands: string[][] = [];
    const runner: Runner = {
      exec: async (command): Promise<ExecResult> => {
        commands.push([...command]);
        // The bare uuid is the standalone resource's container; a service database would be the
        // `postgresql-` one, and only one of the two is ever there.
        if (command[4] !== CONTAINERS[0]) {
          return { code: 1, stdout: "", stderr: `Error: No such object: ${String(command[4])}` };
        }
        // Both networks a Coolify database sits on; the per-service one is not the routable one,
        // which is why `coolify` is picked by name.
        return {
          code: 0,
          stdout: `coolify=${CONTAINER_IP} 4pjq0kw7ty27vsi0xpesevrq=10.0.2.3 \n`,
          stderr: "",
        };
      },
      tunnel: forwarder({ [CONTAINER_IP]: clusterPort }, targets),
    };

    const db = await openDatabase(runner, { admin: clusterAdmin, containers: CONTAINERS });

    try {
      expect(db.kind).toBe("tunnel");
      expect(db.boxAddress).toEqual({ host: CONTAINER_IP, port: 5432 });
      expect(await db.query("SELECT 1")).toEqual({ rows: [["1"]] });
      expect(commands).toEqual([inspectArgv(CONTAINERS[0] ?? "")]);
      expect(targets).toEqual(["127.0.0.1:5432", `${CONTAINER_IP}:5432`]);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("names every container it tried when docker inspect finds none of them", async () => {
    const runner: Runner = {
      exec: async (command) => ({
        code: 1,
        stdout: "",
        stderr: `Error: No such object: ${String(command[4])}`,
      }),
      tunnel: forwarder({}, []),
    };

    const opened = openDatabase(runner, { admin: clusterAdmin, containers: CONTAINERS });

    await expect(opened).rejects.toThrow(/No such object/);
    await expect(opened).rejects.toThrow(new RegExp(CONTAINERS.join(", ")));
  }, 30_000);

  it("refuses a container that has no address on any docker network", async () => {
    const runner: Runner = {
      exec: async () => ({ code: 0, stdout: "none= \n", stderr: "" }),
      tunnel: forwarder({}, []),
    };

    // Through the deprecated single-name option, which is appended to the candidates.
    await expect(
      openDatabase(runner, { admin: clusterAdmin, container: CONTAINERS[0] }),
    ).rejects.toThrow(/no IPv4 address on any docker network/);
  }, 30_000);

  it("falls back to docker exec psql as the configured admin when no address answers", async () => {
    const commands: string[][] = [];
    const runner: Runner = {
      exec: async (command, options): Promise<ExecResult> => {
        commands.push([...command]);
        if (command[1] === "inspect") {
          return { code: 0, stdout: `coolify=${CONTAINER_IP} `, stderr: "" };
        }
        expect(options?.input).toBe("SELECT 1");
        return { code: 0, stdout: "1t\n", stderr: "" };
      },
      tunnel: forwarder({}, []),
    };

    const db = await openDatabase(runner, {
      // Coolify creates the cluster with its own POSTGRES_USER, which need not be `postgres`.
      admin: { user: "coolify_admin" },
      containers: [CONTAINERS[0] ?? ""],
      dockerExec: true,
    });

    expect(db.kind).toBe("docker-exec");
    expect(db.adminUrl()).toBeUndefined();
    expect(await db.query("SELECT 1")).toEqual({ rows: [["1", "t"]] });
    expect(commands).toEqual([
      inspectArgv(CONTAINERS[0] ?? ""),
      [
        "docker",
        "exec",
        "-i",
        CONTAINERS[0] ?? "",
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-qtAF",
        "",
        "-U",
        "coolify_admin",
        "-d",
        "postgres",
        "-f",
        "-",
      ],
    ]);
  }, 30_000);

  it("refuses the tunnel with nothing to fall back to when no container is named", async () => {
    const runner: Runner = {
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      tunnel: forwarder({}, []),
    };

    await expect(openDatabase(runner, { admin: clusterAdmin })).rejects.toThrow(
      /no container was named/,
    );
  }, 30_000);
});

describe("redactPasswords", () => {
  it("blanks an ALTER ROLE literal and a connection string's authority", () => {
    expect(redactPasswords(`ALTER ROLE "hf_demo" LOGIN PASSWORD 'hunter2' CONNECTION LIMIT 25`)).toBe(
      `ALTER ROLE "hf_demo" LOGIN PASSWORD '***' CONNECTION LIMIT 25`,
    );
    expect(redactPasswords("postgresql://hf_demo:hunter2@127.0.0.1:5432/hf_demo")).toBe(
      "postgresql://hf_demo:***@127.0.0.1:5432/hf_demo",
    );
  });
});

/** A port nothing is listening on: bound to learn the number, then given back. */
async function deadPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
