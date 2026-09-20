import { randomBytes } from "node:crypto";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { ADMIN_URL, asRole, createTestDatabase, type TestDatabase } from "@hyperfixation/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalDirectoryBackupSource,
  createS3BackupSource,
  BackupSourceError,
  type BackupSource,
} from "./backup-source.js";
import { InvalidAppName } from "./names.js";
import {
  formatRestoreCheck,
  restoreCheck,
  RestoreCheckError,
  SCRATCH_SUFFIX,
  type RestoreCheckResult,
} from "./restore-check.js";
import { createLocalRunner, type LocalRunner } from "./runner.js";
import { openAppState, type AppStateStore } from "./state.js";

const execFile = promisify(execFileCallback);

/**
 * `pg_dump`, `pg_restore` and the dumps themselves live inside the test cluster's container.
 *
 * Neither a laptop nor `ubuntu-latest` is guaranteed a client of the server's own major version,
 * and a `pg_dump` older than its server refuses to run — so the suite uses the ones shipped
 * beside the server. Which is also the shape the box has: the dumps are where Postgres is.
 */
let container: string;
/** The directory inside that container standing in for Coolify's backup directory. */
let backupDir: string;
let hostDir: string;

/** The cluster as the container sees it; `restoreAdminUrl` on the box is the same idea. */
function containerUrl(database?: string): string {
  const url = new URL(ADMIN_URL);
  url.host = "127.0.0.1:5432";
  if (database !== undefined) url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/** The container publishing the port `ADMIN_URL` names — a service container in CI. */
async function findContainer(): Promise<string> {
  const port = new URL(ADMIN_URL).port === "" ? "5432" : new URL(ADMIN_URL).port;
  const { stdout } = await execFile("docker", ["ps", "--format", "{{.Names}}\t{{.Ports}}"]);
  for (const line of stdout.split("\n")) {
    const [name, ports] = line.split("\t");
    if (name !== undefined && ports !== undefined && ports.includes(`:${port}->`)) return name;
  }
  throw new Error(`no running container publishes port ${port}; HF_TEST_DATABASE_URL is ${ADMIN_URL}`);
}

async function inContainer(command: readonly string[]): Promise<string> {
  const { stdout } = await execFile("docker", ["exec", "-i", container, ...command]);
  return stdout;
}

/**
 * The local recording Runner, with every command run inside the cluster's container.
 *
 * `find`, `stat` and `pg_restore` all have to see the same filesystem the dumps are on, which on
 * the box is the box and here is the container.
 */
function containerRunner(): LocalRunner {
  const local = createLocalRunner();
  return {
    get commands() {
      return local.commands;
    },
    get tunnels() {
      return local.tunnels;
    },
    exec: async (command, options) =>
      await local.exec(["docker", "exec", "-i", container, ...command], options),
    tunnel: async (remotePort, remoteHost) => await local.tunnel(remotePort, remoteHost),
  };
}

async function pgDump(databaseName: string): Promise<string> {
  const file = path.posix.join(backupDir, `${databaseName}-${randomBytes(4).toString("hex")}.dmp`);
  await inContainer(["pg_dump", "-Fc", "-f", file, containerUrl(databaseName)]);
  return file;
}

async function scratchExists(databaseName: string): Promise<boolean> {
  return await asRole(ADMIN_URL, async (admin) => {
    const { rows } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      `${databaseName}${SCRATCH_SUFFIX}`,
    ]);
    return rows.length > 0;
  });
}

const databases: TestDatabase[] = [];

/** A migrated database with a record table of its own, seeded with `rows` widgets. */
async function seededDatabase(rows: number): Promise<TestDatabase> {
  const db = await createTestDatabase();
  databases.push(db);
  await asRole(db.migratorUrl, async (migrator) => {
    await migrator.query(
      "CREATE TABLE widget (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, normalized_name text)",
    );
    for (let index = 0; index < rows; index += 1) {
      await migrator.query("INSERT INTO widget (normalized_name) VALUES ($1)", [`w${String(index)}`]);
    }
  });
  return db;
}

async function stateFor(name: string): Promise<AppStateStore> {
  return await openAppState(name, { dir: hostDir });
}

function rowFor(result: RestoreCheckResult, table: string): RestoreCheckResult["rows"][number] {
  const row = result.rows.find((candidate) => candidate.table === table);
  if (row === undefined) throw new Error(`no row for ${table} in ${JSON.stringify(result.rows)}`);
  return row;
}

/** Everything `restoreCheck` needs but the app, the state and the source. */
function harness(): { runner: LocalRunner; database: string; restoreAdminUrl: string } {
  return { runner: containerRunner(), database: ADMIN_URL, restoreAdminUrl: containerUrl() };
}

beforeAll(async () => {
  container = await findContainer();
  backupDir = `/tmp/hf-restore-check-${randomBytes(4).toString("hex")}`;
  await inContainer(["mkdir", "-p", backupDir]);
  hostDir = await mkdtemp(path.join(tmpdir(), "hf-restore-check-"));
}, 60_000);

afterAll(async () => {
  for (const db of databases) {
    await asRole(ADMIN_URL, async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${db.databaseName}${SCRATCH_SUFFIX}" WITH (FORCE)`);
    });
    await db.drop();
  }
  if (container !== undefined) await inContainer(["rm", "-rf", backupDir]);
  if (hostDir !== undefined) await rm(hostDir, { recursive: true, force: true });
}, 120_000);

describe("restoreCheck", () => {
  it("matches every count, exits 0 and records lastRestoreCheckAt", async () => {
    const db = await seededDatabase(2);
    const dump = await pgDump(db.databaseName);
    const state = await stateFor(db.appName);

    const result = await restoreCheck({
      app: db.appName,
      state,
      source: createLocalDirectoryBackupSource({ runner: containerRunner(), directory: backupDir }),
      ...harness(),
    });

    expect(result.ok).toBe(true);
    expect(result.dump.path).toBe(dump);
    expect(rowFor(result, "widget")).toEqual({ table: "widget", live: 2, restored: 2, verdict: "ok" });
    // The `hf_*` half of the rule, alongside the `normalized_name` half above.
    expect(result.rows.filter((row) => row.table.startsWith("hf_")).length).toBeGreaterThan(5);
    expect(result.rows.every((row) => row.verdict === "ok")).toBe(true);

    expect(state.state.lastRestoreCheckAt).toBeDefined();
    expect(await scratchExists(db.databaseName)).toBe(false);
  }, 120_000);

  it("reports the table a dump taken before a seed disagrees on, and records nothing", async () => {
    const db = await seededDatabase(2);
    await pgDump(db.databaseName);
    await asRole(db.migratorUrl, async (migrator) => {
      await migrator.query("INSERT INTO widget (normalized_name) VALUES ('late')");
    });
    const state = await stateFor(db.appName);

    const result = await restoreCheck({
      app: db.appName,
      state,
      source: createLocalDirectoryBackupSource({ runner: containerRunner(), directory: backupDir }),
      ...harness(),
    });

    expect(result.ok).toBe(false);
    expect(rowFor(result, "widget")).toEqual({
      table: "widget",
      live: 3,
      restored: 2,
      verdict: "mismatch",
    });
    expect(state.state.lastRestoreCheckAt).toBeUndefined();
    expect(await scratchExists(db.databaseName)).toBe(false);
  }, 120_000);

  it("gives a table only one side has its own verdict rather than a crash", async () => {
    const db = await seededDatabase(1);
    await pgDump(db.databaseName);
    // An app migration between the backup and the check, in both directions at once.
    await asRole(db.migratorUrl, async (migrator) => {
      await migrator.query("DROP TABLE widget");
      await migrator.query("CREATE TABLE late_widget (id int, normalized_name text)");
    });

    const result = await restoreCheck({
      app: db.appName,
      state: await stateFor(db.appName),
      source: createLocalDirectoryBackupSource({ runner: containerRunner(), directory: backupDir }),
      ...harness(),
    });

    expect(result.ok).toBe(false);
    expect(rowFor(result, "widget")).toEqual({ table: "widget", restored: 1, verdict: "restored only" });
    expect(rowFor(result, "late_widget")).toEqual({
      table: "late_widget",
      live: 0,
      verdict: "live only",
    });
  }, 120_000);

  it("drops the scratch database when the restore itself fails", async () => {
    const db = await seededDatabase(1);
    const junk = path.posix.join(backupDir, `${db.databaseName}-not-a-dump.dmp`);
    await inContainer(["sh", "-c", `printf 'not a dump' > ${junk}`]);
    const source: BackupSource = {
      kind: "local-directory",
      newest: async () => ({ path: junk, takenAt: new Date(), from: backupDir }),
    };
    const state = await stateFor(db.appName);

    await expect(
      restoreCheck({ app: db.appName, state, source, ...harness() }),
    ).rejects.toThrow(RestoreCheckError);

    expect(await scratchExists(db.databaseName)).toBe(false);
    expect(state.state.lastRestoreCheckAt).toBeUndefined();
  }, 120_000);

  it("runs pg_restore as the app's migrator, with no owners and no comments", async () => {
    const db = await seededDatabase(1);
    const dump = await pgDump(db.databaseName);
    const runner = containerRunner();

    await restoreCheck({
      app: db.appName,
      state: await stateFor(db.appName),
      source: createLocalDirectoryBackupSource({ runner, directory: backupDir }),
      runner,
      database: ADMIN_URL,
      restoreAdminUrl: containerUrl(),
    });

    const restore = runner.commands.find((command) => command.includes("pg_restore"));
    expect(restore?.slice(restore.indexOf("pg_restore"))).toEqual([
      "pg_restore",
      "--no-owner",
      "--no-comments",
      `--role=${db.roles.migrator}`,
      "--dbname",
      containerUrl(`${db.databaseName}${SCRATCH_SUFFIX}`),
      dump,
    ]);
  }, 120_000);

  it("refuses an app name carrying shell or SQL metacharacters before it touches the cluster", async () => {
    const source: BackupSource = {
      kind: "local-directory",
      newest: async () => {
        throw new Error("the name should have been refused first");
      },
    };

    for (const app of ["demo'; DROP DATABASE postgres; --", "demo$(id)", 'de"mo', "demo;ls"]) {
      await expect(
        restoreCheck({ app, state: await stateFor("bad"), source, ...harness() }),
      ).rejects.toThrow(InvalidAppName);
    }
  }, 30_000);

  it("refuses a name whose scratch database would not fit an identifier", async () => {
    const source: BackupSource = { kind: "local-directory", newest: async () => undefined };

    await expect(
      restoreCheck({ app: "a".repeat(55), state: await stateFor("long"), source, ...harness() }),
    ).rejects.toThrow(/identifier limit/);
  });

  it("says so when the source holds no dump at all", async () => {
    const source: BackupSource = { kind: "local-directory", newest: async () => undefined };

    await expect(
      restoreCheck({ app: "demo", state: await stateFor("demo"), source, ...harness() }),
    ).rejects.toThrow(/no hf_demo dump/);
  });
});

describe("formatRestoreCheck", () => {
  const base: RestoreCheckResult = {
    databaseName: "hf_demo",
    scratchDatabase: `hf_demo${SCRATCH_SUFFIX}`,
    dump: { path: "/data/coolify/backups/hf_demo.dmp", takenAt: new Date(), from: "/data" },
    dumpAgeHours: 3.25,
    dumpStale: false,
    rows: [
      { table: "hf_app_state", live: 1, restored: 1, verdict: "ok" },
      { table: "widget", live: 3, restored: 2, verdict: "mismatch" },
      { table: "late_widget", live: 0, verdict: "live only" },
    ],
    ok: false,
  };

  it("prints the age, the four columns and how many did not match", () => {
    const lines = formatRestoreCheck(base);

    expect(lines[0]).toBe("hf_demo: /data/coolify/backups/hf_demo.dmp, 3.3 h old");
    expect(lines[1]).toBe("table         live  restored  verdict");
    expect(lines).toContain("late_widget   0     —         live only");
    expect(lines.at(-1)).toBe("2 of 3 table(s) did not match");
  });

  it("warns above 36 h, and says nothing about age below it", () => {
    expect(formatRestoreCheck({ ...base, dumpAgeHours: 51, dumpStale: true })[1]).toContain(
      "WARNING: the dump is 51.0 h old — over 36 h",
    );
    expect(formatRestoreCheck(base).join("\n")).not.toContain("WARNING");
  });
});

describe("the local-directory backup source", () => {
  it("picks the newest dump by mtime and ignores other databases", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hf-dumps-"));
    try {
      const write = async (name: string, ageHours: number): Promise<string> => {
        const file = path.join(dir, name);
        await writeFile(file, "dump");
        const when = new Date(Date.now() - ageHours * 3_600_000);
        await utimes(file, when, when);
        return file;
      };
      await write("hf_demo-old.dmp", 48);
      const newest = await write("hf_demo-new.dmp", 2);
      await write("hf_other-new.dmp", 1);

      const source = createLocalDirectoryBackupSource({ runner: createLocalRunner(), directory: dir });
      const dump = await source.newest("hf_demo");

      expect(dump?.path).toBe(newest);
      expect(Date.now() - (dump?.takenAt.getTime() ?? 0)).toBeGreaterThan(3_600_000);
      expect(await source.newest("hf_missing")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("names the directory it could not list", async () => {
    const source = createLocalDirectoryBackupSource({
      runner: createLocalRunner(),
      directory: path.join(tmpdir(), `hf-absent-${randomBytes(4).toString("hex")}`),
    });

    await expect(source.newest("hf_demo")).rejects.toThrow(BackupSourceError);
  }, 30_000);

  it("refuses a database name that would reach find as a glob", async () => {
    const source = createLocalDirectoryBackupSource({ runner: createLocalRunner(), directory: tmpdir() });

    await expect(source.newest("hf_demo*")).rejects.toThrow(BackupSourceError);
  });
});

describe("the S3 backup source", () => {
  it("is a documented refusal, not a silent empty source", async () => {
    await expect(createS3BackupSource().newest("hf_demo")).rejects.toThrow(/not implemented/);
  });
});
