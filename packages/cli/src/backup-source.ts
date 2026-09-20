import { APP_ID } from "./names.js";
import type { Runner } from "./runner.js";

/** Where Coolify writes a database backup it was not told to send to S3. */
export const COOLIFY_BACKUP_DIR = "/data/coolify/backups";

export type BackupSourceKind = "local-directory" | "hetzner-s3";

export interface BackupDump {
  /** A path `pg_restore` can read on the runner's side. */
  path: string;
  /** The dump's mtime — what `hf restore-check` reports an age against. */
  takenAt: Date;
  /** Where it was found, for the message when nothing was. */
  from: string;
}

/** One place `hf restore-check` can get the newest dump of a database from. */
export interface BackupSource {
  readonly kind: BackupSourceKind;
  /** The newest dump of `databaseName`, or `undefined` when the source holds none. */
  newest(databaseName: string): Promise<BackupDump | undefined>;
}

export class BackupSourceError extends Error {
  readonly kind: BackupSourceKind;

  constructor(kind: BackupSourceKind, message: string) {
    super(`${kind}: ${message}`);
    this.name = "BackupSourceError";
    this.kind = kind;
  }
}

export interface LocalDirectoryBackupSourceOptions {
  /** Where the dumps are listed and stat'ed: the box, or this machine in a test. */
  runner: Runner;
  /** Defaults to `COOLIFY_BACKUP_DIR`. */
  directory?: string;
  /** How deep under `directory` to look; Coolify nests dumps per database uuid. */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 4;

/**
 * The dumps Coolify keeps on the box's own disk, newest by mtime.
 *
 * mtime rather than the filename's timestamp: Coolify's naming is one of the things Phase 0
 * never pinned down, so the match is `*<database>*` and the ordering is the filesystem's.
 */
export function createLocalDirectoryBackupSource(
  options: LocalDirectoryBackupSourceOptions,
): BackupSource {
  const directory = options.directory ?? COOLIFY_BACKUP_DIR;
  const { runner } = options;

  return {
    kind: "local-directory",
    newest: async (databaseName) => {
      assertGlobSafe(databaseName);

      const listed = await runner.exec([
        "find",
        directory,
        "-maxdepth",
        String(options.maxDepth ?? DEFAULT_MAX_DEPTH),
        "-type",
        "f",
        "-name",
        `*${databaseName}*`,
      ]);
      if (listed.code !== 0) {
        throw new BackupSourceError(
          "local-directory",
          `could not list ${directory} on the box: ${listed.stderr.trim()}`,
        );
      }

      const paths = listed.stdout.split("\n").filter((line) => line !== "");
      if (paths.length === 0) return undefined;

      const mtimes = await mtimeSeconds(runner, paths);
      let newest: BackupDump | undefined;
      for (const [index, path] of paths.entries()) {
        const seconds = mtimes[index];
        if (seconds === undefined) continue;
        if (newest === undefined || seconds * 1000 > newest.takenAt.getTime()) {
          newest = { path, takenAt: new Date(seconds * 1000), from: directory };
        }
      }
      return newest;
    },
  };
}

/**
 * `stat`, whichever one the far side has: GNU spells the mtime `-c %Y` and BSD `-f %m`, and the
 * box is Ubuntu while the suite runs on whatever the laptop is.
 */
async function mtimeSeconds(runner: Runner, paths: readonly string[]): Promise<number[]> {
  for (const flags of [
    ["-c", "%Y"],
    ["-f", "%m"],
  ]) {
    const result = await runner.exec(["stat", ...flags, "--", ...paths]);
    if (result.code !== 0) continue;
    const seconds = result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => Number(line.trim()));
    if (seconds.length === paths.length && seconds.every((value) => Number.isFinite(value))) {
      return seconds;
    }
  }
  throw new BackupSourceError("local-directory", "neither GNU nor BSD stat reported an mtime");
}

/**
 * The dumps in Hetzner's object storage — **not implemented**.
 *
 * Risk 3 of the Phase 3 order is still open: nobody has looked in `/data/coolify/backups` on the
 * box, so which of the two sources is the real one is unknown, and the operator config has no
 * S3 key to read (`CONFIG_KEYS` carries none). Rather than guess a bucket layout and a key name,
 * this refuses with the one sentence that says what to do. The key, when it exists, belongs in
 * the operator config and is never written into an app's environment.
 */
export function createS3BackupSource(): BackupSource {
  return {
    kind: "hetzner-s3",
    newest: async () => {
      throw new BackupSourceError(
        "hetzner-s3",
        "downloading a dump from Hetzner object storage is not implemented: the operator config " +
          "has no S3 key yet (risk 3 of the Phase 3 order). Run without --from-s3 against " +
          `${COOLIFY_BACKUP_DIR} on the box, or pass --backup-dir.`,
      );
    },
  };
}

/**
 * The database name reaches `find` as a `*name*` pattern, so it may not carry a glob character.
 *
 * `deriveNames` has already refused anything outside `APP_ID` by the time `hf restore-check`
 * gets here; this is the check at the point where the string becomes a pattern.
 */
function assertGlobSafe(databaseName: string): void {
  if (!APP_ID.test(databaseName)) {
    throw new BackupSourceError(
      "local-directory",
      `${JSON.stringify(databaseName)} is not a usable database name`,
    );
  }
}
