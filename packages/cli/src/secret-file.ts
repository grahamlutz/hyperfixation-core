import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Owner read/write and nothing else — the only mode the operator's files are read at. */
export const SECRET_MODE = 0o600;

/** The mode a secret directory is created at, so a new file cannot be listed by anyone else. */
const SECRET_DIR_MODE = 0o700;

/**
 * A file that holds secrets was readable or writable by someone other than its owner.
 *
 * Thrown *after* the file has been tightened to 0600: the operator's next run works, and this
 * run stops loudly enough that they can decide whether anything in it needs rotating. Nothing
 * of the file's contents reaches the message.
 */
export class InsecureFileMode extends Error {
  readonly file: string;
  /** The permission bits found, before they were tightened. */
  readonly found: number;

  constructor(file: string, found: number) {
    super(
      `${file} was mode ${found.toString(8).padStart(4, "0")}, not 0600: other users on this ` +
        `machine could read it. It has been tightened to 0600 — rerun, and rotate anything it ` +
        `holds that may have been read.`,
    );
    this.name = "InsecureFileMode";
    this.file = file;
    this.found = found;
  }
}

/**
 * Reads a file that holds secrets, or `undefined` when it does not exist.
 *
 * Refuses a file any other user can reach, having first tightened it — see `InsecureFileMode`.
 */
export async function readSecretFile(file: string): Promise<string | undefined> {
  let mode: number;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }

  if ((mode & 0o077) !== 0) {
    await chmod(file, SECRET_MODE);
    throw new InsecureFileMode(file, mode);
  }
  return await readFile(file, "utf8");
}

/**
 * Writes a file that holds secrets, at 0600, atomically.
 *
 * Temp file then `rename`, because the state cache is written between provisioning steps: a
 * crash partway through a write would otherwise leave a half-written JSON file that the next
 * run refuses, and the passwords and tokens it held are not recoverable from anywhere else.
 * The temp file is created 0600 too, so the secrets are never briefly world-readable.
 */
export async function writeSecretFile(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: SECRET_DIR_MODE });

  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, contents, { mode: SECRET_MODE });
    await chmod(temp, SECRET_MODE);
    await rename(temp, file);
  } catch (cause) {
    await rm(temp, { force: true });
    throw cause;
  }
}
