import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveApp, type ResolvedApp } from "./app.js";
import { run } from "./spawn.js";

/** Track B's generators: `flow` and `record`, each of which also writes the registration. */
export const GENERATOR_CONFIG = path.join("turbo", "generators", "config.ts");

/** `@turbo/gen` declares its bin as `gen`; that is the name pnpm links into the app. */
export const GENERATOR_BIN = "gen";

export class NoGenerators extends Error {
  constructor(dir: string) {
    super(`${dir} has no ${GENERATOR_CONFIG}; hf gen has nothing to run`);
    this.name = "NoGenerators";
  }
}

export interface GenerateOptions {
  dir?: string;
  /** Generator name and any `--flag value` pairs, passed through to `turbo gen`. */
  args?: readonly string[];
}

/**
 * `hf gen` — the app's own Turborepo generators, run through the app's `turbo`.
 *
 * It adds nothing to the generators but the ability to run them from anywhere inside the app,
 * and deliberately holds no templates of its own: a generator's whole value is that it writes
 * the *registration* as well as the file, and only the app's `src/hyperfixation.ts` can be
 * appended to. A copy of the templates in this package would be a second one to keep in step
 * with the registry shape.
 *
 * `@turbo/gen`'s own bin, not `turbo gen`. `turbo gen` re-fetches `@turbo/gen` through
 * `pnpm dlx` even when the app already depends on it, and that second copy is installed outside
 * the app's `pnpm-workspace.yaml` — so it is refused by pnpm 12 for `esbuild`'s build script,
 * which the app's own `allowBuilds` had already permitted. The installed bin is the same
 * generator with none of that.
 */
export async function generate(options: GenerateOptions = {}): Promise<ResolvedApp> {
  const app = await resolveApp(options.dir);
  if (!(await isFile(path.join(app.dir, GENERATOR_CONFIG)))) throw new NoGenerators(app.dir);

  await run("pnpm", ["exec", GENERATOR_BIN, "run", ...(options.args ?? [])], { cwd: app.dir });
  return app;
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}
