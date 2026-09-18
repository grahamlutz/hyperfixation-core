import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { deriveNames, type AppNames } from "./names.js";
import { readEnvFile } from "./env-file.js";

/** What makes a directory an app rather than any package: the registry `defineApp` lives in. */
const APP_ENTRY = path.join("src", "hyperfixation.ts");

export class NotAnApp extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAnApp";
  }
}

export interface ResolvedApp {
  dir: string;
  /** `package.json`'s `name`, which is what `hf new` substituted for `__APP_NAME__`. */
  appName: string;
  names: AppNames;
  /** The app's own migrations, which `hf migrate` and E005 both read. */
  migrationsDir: string;
  /** `.env` under `process.env`, the precedence every dotenv loader uses. */
  env: Record<string, string | undefined>;
  /** `.env` alone, so `hf check` can say a name is missing from the file and not from a shell. */
  envFile: Record<string, string>;
  /** The names `.env.example` declares; the app's env contract, kept equal to `REQUIRED_ENV`. */
  declared: readonly string[];
}

/**
 * Finds the app around `dir` and reads everything the other commands need from it.
 *
 * The app name comes from `package.json` rather than from a file `hf new` leaves behind: the
 * template's `package.json` carries `__APP_NAME__`, so after substitution it already *is* the
 * record, and a second copy of the name is a second thing that can disagree.
 */
export async function resolveApp(dir: string = process.cwd()): Promise<ResolvedApp> {
  const root = await findAppRoot(path.resolve(dir));
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    name?: unknown;
  };
  if (typeof manifest.name !== "string") {
    throw new NotAnApp(`${root}/package.json has no name`);
  }

  const envFile = await readEnvFile(path.join(root, ".env"));
  const example = await readEnvFile(path.join(root, ".env.example"));

  return {
    dir: root,
    appName: manifest.name,
    names: deriveNames(manifest.name),
    migrationsDir: path.join(root, "drizzle"),
    env: { ...envFile, ...process.env },
    envFile,
    declared: Object.keys(example),
  };
}

async function findAppRoot(from: string): Promise<string> {
  let dir = from;
  for (;;) {
    if (await isFile(path.join(dir, APP_ENTRY))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new NotAnApp(
        `no hyperfixation app at or above ${from}: ${APP_ENTRY} is what marks one`,
      );
    }
    dir = parent;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}
