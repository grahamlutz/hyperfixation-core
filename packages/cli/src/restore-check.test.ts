import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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
import { createLocalRunner, type ExecOptions, type ExecResult, type Runner } from "./runner.js";
import { openAppState, type AppStateStore } from "./state.js";

const execFile = promisify(execFileCallback);

/**
 * The Postgres container: the only place in this suite with a Postgres client binary.
 *
 * The box has the same shape. Coolify runs Postgres in a container and the host has no client
 * tools at all, so a `pg_restore` on the host exits 127 — which is what `hostRunner` below
 * reproduces, and what the real `hf restore-check demo-app` hit.
 */
let container: string;
/** Coolify's backup directory, on the **host**: where the dumps are and `pg_restore` is not. */
let backupDir: string;
let hostDir: string;

/** The cluster as the container sees it, for the `pg_dump` that produces a fixture. */
function containerUrl(database?: string): string {
  const url = new URL(ADMIN_URL);
  url.host = "127.0.0.1:5432";
  if (database !== undefined) url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/** The cluster superuser, which is what `-U` inside the container has to be. */
function adminUser(): string {
  return decodeURIComponent(new URL(ADMIN_URL).username);
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

/** What a box host has no binary for, and answers exactly as a shell does when asked. */
const NO_SUCH_BINARY = new Set(["pg_restore", "pg_dump", "psql", "createdb", "pg_dumpall"]);

interface HostRunner extends Runner {
  /** Every `exec`, including the ones the host refused; `commands` records only what ran. */
  readonly calls: readonly { command: readonly string[]; options?: ExecOptions }[];
}

/**
 * The box host: `find`, `stat` and `docker` work, and no Postgres client binary exists.
 *
 * Everything else about it is this machine, so a `docker exec` it is handed really runs against
 * the test cluster's container and the restore is exercised end to end.
 */
function hostRunner(stub?: (command: readonly string[]) => ExecResult | undefined): HostRunner {
  const local = createLocalRunner();
  const calls: { command: readonly string[]; options?: ExecOptions }[] = [];

  return {
    get calls() {
      return calls;
    },
    exec: async (command, options) => {
      calls.push({ command: [...command], options });
      const stubbed = stub?.(command);
      if (stubbed !== undefined) return stubbed;
      const [bin] = command;
      if (bin !== undefined && NO_SUCH_BINARY.has(bin)) {
        return { code: 127, stdout: "", stderr: `bash: line 1: ${bin}: command not found` };
      }
      return await local.exec(command, options);
    },
    tunnel: async (remotePort, remoteHost) => await local.tunnel(remotePort, remoteHost),
  };
}

/** The `docker exec … pg_restore` call in a runner's log, or nothing. */
function restoreCall(
  runner: HostRunner,
): { command: readonly string[]; options?: ExecOptions } | undefined {
  return runner.calls.find((call) => call.command.includes("pg_restore"));
}

/**
 * A dump on the **host**, the way Coolify leaves one: `pg_dump -Fc` to stdout inside the
 * container, written to a host file that is never mounted back in.
 */
async function pgDump(databaseName: string): Promise<string> {
  const epoch = String(Math.floor(Date.now() / 1000));
  const file = path.join(backupDir, `pg-dump-${databaseName}-${epoch}.dmp`);
  const { stdout } = await execFile(
    "docker",
    ["exec", "-i", container, "pg_dump", "-Fc", containerUrl(databaseName)],
    { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
  );
  await writeFile(file, stdout);
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
function harness(runner: HostRunner = hostRunner()): {
  runner: HostRunner;
  database: string;
  container: string;
  adminUser: string;
} {
  return { runner, database: ADMIN_URL, container, adminUser: adminUser() };
}

/** The host source: the dumps are on the host's disk, so `find` and `stat` run there. */
function hostSource(runner: HostRunner): BackupSource {
  return createLocalDirectoryBackupSource({ runner, directory: backupDir });
}

beforeAll(async () => {
  container = await findContainer();
  hostDir = await mkdtemp(path.join(tmpdir(), "hf-restore-check-"));
  backupDir = path.join(hostDir, "backups");
  await mkdir(backupDir, { recursive: true });
}, 60_000);

afterAll(async () => {
  for (const db of databases) {
    await asRole(ADMIN_URL, async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS "${db.databaseName}${SCRATCH_SUFFIX}" WITH (FORCE)`);
    });
    await db.drop();
  }
  if (hostDir !== undefined) await rm(hostDir, { recursive: true, force: true });
}, 120_000);

describe("restoreCheck", () => {
  it("matches every count, exits 0 and records lastRestoreCheckAt", async () => {
    const db = await seededDatabase(2);
    const dump = await pgDump(db.databaseName);
    const state = await stateFor(db.appName);
    const runner = hostRunner();

    const result = await restoreCheck({
      app: db.appName,
      state,
      source: hostSource(runner),
      ...harness(runner),
    });

    expect(result.ok).toBe(true);
    expect(result.dump.path).toBe(dump);
    expect(result.strict).toBe(false);
    expect(rowFor(result, "widget")).toEqual({ table: "widget", live: 2, restored: 2, verdict: "ok" });
    // The `hf_*` half of the rule, alongside the `normalized_name` half above.
    expect(result.rows.filter((row) => row.table.startsWith("hf_")).length).toBeGreaterThan(5);
    expect(result.rows.every((row) => row.verdict === "ok")).toBe(true);

    expect(state.state.lastRestoreCheckAt).toBeDefined();
    expect(await scratchExists(db.databaseName)).toBe(false);
    // The host had no `pg_restore` to offer, and was never asked for one.
    expect(runner.calls.some((call) => call.command[0] === "pg_restore")).toBe(false);
  }, 120_000);

  it("reports the table a dump taken before a seed disagrees on, and records nothing", async () => {
    const db = await seededDatabase(2);
    await pgDump(db.databaseName);
    await asRole(db.migratorUrl, async (migrator) => {
      await migrator.query("INSERT INTO widget (normalized_name) VALUES ('late')");
    });
    const state = await stateFor(db.appName);
    const runner = hostRunner();

    const result = await restoreCheck({
      app: db.appName,
      state,
      source: hostSource(runner),
      ...harness(runner),
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

  it("reads an append-only table the live side has moved on from as drift, and still passes", async () => {
    const db = await seededDatabase(1);
    await pgDump(db.databaseName);
    // What X1 hit: an app that kept working between the dump and the check. `hf_audit` is
    // insert-only, so two extra live rows are the app running, not a dump that lost them.
    await asRole(db.migratorUrl, async (migrator) => {
      await migrator.query("INSERT INTO hf_audit (action) VALUES ('after-the-dump'), ('again')");
    });
    const state = await stateFor(db.appName);
    const runner = hostRunner();

    const result = await restoreCheck({
      app: db.appName,
      state,
      source: hostSource(runner),
      ...harness(runner),
    });

    expect(result.ok).toBe(true);
    expect(result.matched).toBe(true);
    expect(rowFor(result, "hf_audit")).toEqual({
      table: "hf_audit",
      live: 2,
      restored: 0,
      drift: 2,
      verdict: "drift",
    });
    expect(state.state.lastRestoreCheckAt).toBeDefined();
  }, 120_000);

  it("fails an append-only table the dump has more of than the live database", async () => {
    const db = await seededDatabase(1);
    await asRole(db.migratorUrl, async (migrator) => {
      await migrator.query("INSERT INTO hf_audit (action) VALUES ('before-the-dump')");
    });
    await pgDump(db.databaseName);
    // Rows an append-only table cannot lose, lost: the one thing the drift rule must not hide.
    await asRole(db.migratorUrl, async (migrator) => {
      await migrator.query("DELETE FROM hf_audit");
    });
    const state = await stateFor(db.appName);
    const runner = hostRunner();

    const result = await restoreCheck({
      app: db.appName,
      state,
      source: hostSource(runner),
      ...harness(runner),
    });

    expect(result.ok).toBe(false);
    expect(rowFor(result, "hf_audit")).toEqual({
      table: "hf_audit",
      live: 0,
      restored: 1,
      verdict: "mismatch",
    });
    expect(state.state.lastRestoreCheckAt).toBeUndefined();
  }, 120_000);

  it("fails a table that is not on the append-only list however it differs", async () => {
    const db = await seededDatabase(1);
    await pgDump(db.databaseName);
    // `hf_label` is insert-only today and deliberately not listed, so the same churn that is
    // drift on `hf_audit` is still a mismatch here.
    await asRole(db.migratorUrl, async (migrator) => {
      await migrator.query(
        "INSERT INTO hf_label (record_type, record_id, target, value) VALUES ('widget', '1', 'record', 'up')",
      );
    });

    const runner = hostRunner();
    const result = await restoreCheck({
      app: db.appName,
      state: await stateFor(db.appName),
      source: hostSource(runner),
      ...harness(runner),
    });

    expect(result.ok).toBe(false);
    expect(rowFor(result, "hf_label")).toEqual({
      table: "hf_label",
      live: 1,
      restored: 0,
      verdict: "mismatch",
    });
  }, 120_000);

  it("--strict holds an append-only table to the same exact count as everything else", async () => {
    const db = await seededDatabase(1);
    await pgDump(db.databaseName);
    await asRole(db.migratorUrl, async (migrator) => {
      await migrator.query("INSERT INTO hf_audit (action) VALUES ('after-the-dump')");
    });
    const state = await stateFor(db.appName);
    const runner = hostRunner();

    const result = await restoreCheck({
      app: db.appName,
      state,
      source: hostSource(runner),
      strict: true,
      ...harness(runner),
    });

    expect(result.strict).toBe(true);
    expect(result.ok).toBe(false);
    expect(rowFor(result, "hf_audit")).toEqual({
      table: "hf_audit",
      live: 1,
      restored: 0,
      verdict: "mismatch",
    });
    expect(state.state.lastRestoreCheckAt).toBeUndefined();
  }, 120_000);

  it("gives a table only one side has its own verdict rather than a crash", async () => {
    const db = await seededDatabase(1);
    await pgDump(db.databaseName);
    // An app migration between the backup and the check, in both directions at once.
    await asRole(db.migratorUrl, async (migrator) => {
      await migrator.query("DROP TABLE widget");
      await migrator.query("CREATE TABLE late_widget (id int, normalized_name text)");
    });

    const runner = hostRunner();
    const result = await restoreCheck({
      app: db.appName,
      state: await stateFor(db.appName),
      source: hostSource(runner),
      ...harness(runner),
    });

    expect(result.ok).toBe(false);
    expect(rowFor(result, "widget")).toEqual({ table: "widget", restored: 1, verdict: "restored only" });
    expect(rowFor(result, "late_widget")).toEqual({
      table: "late_widget",
      live: 0,
      verdict: "live only",
    });
  }, 120_000);

  it("reports pg_restore's own stderr and drops the scratch database when the restore fails", async () => {
    const db = await seededDatabase(1);
    const junk = path.join(backupDir, `pg-dump-${db.databaseName}-not-a-dump.dmp`);
    await writeFile(junk, "not a dump");
    const source: BackupSource = {
      kind: "local-directory",
      newest: async () => ({ path: junk, takenAt: new Date(), from: backupDir }),
    };
    const state = await stateFor(db.appName);

    await expect(
      restoreCheck({ app: db.appName, state, source, ...harness() }),
    ).rejects.toThrow(/pg_restore exited [1-9]\d* restoring .*not-a-dump\.dmp in .*: .*archive/i);

    expect(await scratchExists(db.databaseName)).toBe(false);
    expect(state.state.lastRestoreCheckAt).toBeUndefined();
  }, 120_000);

  it("runs pg_restore inside the container, as the migrator, with the dump on stdin", async () => {
    const db = await seededDatabase(1);
    const dump = await pgDump(db.databaseName);
    const runner = hostRunner();

    await restoreCheck({
      app: db.appName,
      state: await stateFor(db.appName),
      source: hostSource(runner),
      ...harness(runner),
    });

    const call = restoreCall(runner);
    expect(call?.command).toEqual([
      "docker",
      "exec",
      "-i",
      container,
      "pg_restore",
      "--no-owner",
      "--no-comments",
      `--role=${db.roles.migrator}`,
      "-U",
      adminUser(),
      "-d",
      `${db.databaseName}${SCRATCH_SUFFIX}`,
    ]);
    // The dump is a host file and is not mounted into the container: stdin is the whole route,
    // and nothing names it on the command line.
    expect(call?.options?.inputFile).toBe(dump);
    expect(call?.command).not.toContain(dump);
  }, 120_000);

  it("says what to do when the restore exits 127, and still drops the scratch database", async () => {
    const db = await seededDatabase(1);
    const dump = await pgDump(db.databaseName);
    // What the box answered before the restore moved into the container.
    const runner = hostRunner((command) =>
      command.includes("pg_restore")
        ? { code: 127, stdout: "", stderr: "bash: line 1: pg_restore: command not found" }
        : undefined,
    );
    const state = await stateFor(db.appName);

    await expect(
      restoreCheck({ app: db.appName, state, source: hostSource(runner), ...harness(runner) }),
    ).rejects.toThrow(
      new RegExp(
        `pg_restore exited 127 restoring ${dump} in ${container}: ` +
          `bash: line 1: pg_restore: command not found — exit 127 means "command not found"\\. ` +
          "The box host has no Postgres client tools; only the container does\\.",
      ),
    );

    expect(await scratchExists(db.databaseName)).toBe(false);
    expect(state.state.lastRestoreCheckAt).toBeUndefined();
  }, 120_000);

  it("names the container it could not exec into, and drops the scratch database", async () => {
    const db = await seededDatabase(1);
    await pgDump(db.databaseName);
    const runner = hostRunner();
    const absent = `hf-no-such-container-${randomBytes(4).toString("hex")}`;
    const state = await stateFor(db.appName);

    await expect(
      restoreCheck({
        app: db.appName,
        state,
        source: hostSource(runner),
        ...harness(runner),
        container: absent,
      }),
    ).rejects.toThrow(new RegExp(`pg_restore exited .* in ${absent}: .*No such container`));

    expect(await scratchExists(db.databaseName)).toBe(false);
    expect(state.state.lastRestoreCheckAt).toBeUndefined();
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
    strict: false,
    rows: [
      { table: "hf_app_state", live: 1, restored: 1, verdict: "ok" },
      { table: "widget", live: 3, restored: 2, verdict: "mismatch" },
      { table: "late_widget", live: 0, verdict: "live only" },
    ],
    matched: false,
    ok: false,
  };

  it("prints the age, the four columns and how many did not match", () => {
    const lines = formatRestoreCheck(base);

    expect(lines[0]).toBe("hf_demo: /data/coolify/backups/hf_demo.dmp, 3.3 h old");
    expect(lines[1]).toBe("table         live  restored  verdict");
    expect(lines).toContain("late_widget   0     —         live only");
    expect(lines.at(-1)).toBe("2 of 3 table(s) did not match");
  });

  it("spells a drift row ok (drift +N) and counts it as matched", () => {
    const lines = formatRestoreCheck({
      ...base,
      rows: [
        { table: "hf_app_state", live: 1, restored: 1, verdict: "ok" },
        { table: "hf_run", live: 30, restored: 3, drift: 27, verdict: "drift" },
      ],
      matched: true,
      ok: true,
    });

    expect(lines).toContain("hf_run        30    3         ok (drift +27)");
    expect(lines.at(-1)).toBe("2 table(s) matched, 1 with drift since the dump");
  });

  it("warns above 24 h, and says nothing about age below it", () => {
    expect(formatRestoreCheck({ ...base, dumpAgeHours: 51, dumpStale: true })[1]).toContain(
      "WARN: the dump is 51.0 h old — over 24 h",
    );
    expect(formatRestoreCheck(base).join("\n")).not.toContain("WARN");
  });

  it("says so in the header when the comparison was strict", () => {
    expect(formatRestoreCheck({ ...base, strict: true })[0]).toBe(
      "hf_demo: /data/coolify/backups/hf_demo.dmp, 3.3 h old, strict",
    );
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
