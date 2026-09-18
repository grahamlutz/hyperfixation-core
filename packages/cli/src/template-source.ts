import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEMPLATE_MARKER, TemplateError } from "./new.js";

/** Points `hf new` at a template checkout; what a CI job or a second checkout sets. */
export const TEMPLATE_DIR_ENV = "HF_TEMPLATE_DIR";

/**
 * Where `hf new --local` looks when `--from` is not given: the environment, then the sibling
 * checkout beside the working directory, then the sibling beside this package's own repo.
 *
 * The last one is what makes `hf new demo-app --local` work when `hf` is run from inside
 * hyperfixation-core, which is the Phase 1 development layout the plan describes:
 *
 *   Code/
 *     hyperfixation/            (this repo)
 *     hyperfixation-template/
 */
export async function findTemplateSource(cwd: string = process.cwd()): Promise<string | undefined> {
  const fromEnv = process.env[TEMPLATE_DIR_ENV];
  const candidates = [
    ...(fromEnv === undefined || fromEnv === "" ? [] : [path.resolve(fromEnv)]),
    path.resolve(cwd, "..", "hyperfixation-template"),
    path.resolve(fileURLToPath(new URL("../../..", import.meta.url)), "..", "hyperfixation-template"),
  ];

  for (const candidate of candidates) {
    if (await isTemplate(candidate)) return candidate;
  }
  return undefined;
}

/** The same search, but a miss is the error the user has to act on rather than `undefined`. */
export async function requireTemplateSource(cwd?: string): Promise<string> {
  const found = await findTemplateSource(cwd);
  if (found === undefined) {
    throw new TemplateError(
      `no hyperfixation-template checkout found: pass --from <dir> or set ${TEMPLATE_DIR_ENV}`,
    );
  }
  return found;
}

async function isTemplate(dir: string): Promise<boolean> {
  try {
    return (await stat(path.join(dir, TEMPLATE_MARKER))).isFile();
  } catch {
    return false;
  }
}
