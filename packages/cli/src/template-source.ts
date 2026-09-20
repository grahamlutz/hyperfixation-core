import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadTemplate } from "giget";
import { TEMPLATE_MARKER, TemplateError } from "./new.js";

/** Points `hf new` at a template checkout; what a CI job or a second checkout sets. */
export const TEMPLATE_DIR_ENV = "HF_TEMPLATE_DIR";

/** What a cloud `hf new` fetches when `--from` is absent; giget's `gh:` provider resolves it. */
export const TEMPLATE_REPOSITORY = "gh:grahamlutz/hyperfixation-template";

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

/** giget's `downloadTemplate`, narrowed to what `fetchTemplate` asks of it so a test can be one. */
export type TemplateDownload = (
  source: string,
  options: { dir: string; force: boolean },
) => Promise<{ dir: string }>;

export interface FetchTemplateOptions {
  /** Replaces the real download; the tests never reach the network. */
  download?: TemplateDownload;
}

/**
 * Fetches the template into `dir` — the cloud path's counterpart to `requireTemplateSource`.
 *
 * `source` is a giget specifier (`gh:owner/repo`, optionally `#ref`), defaulting to
 * `TEMPLATE_REPOSITORY`; `--from` passes whatever the operator typed straight through, so a
 * branch or a fork needs no flag of its own. What arrives is checked for `TEMPLATE_MARKER`
 * before `newApp` is let near it: a specifier that resolves to some other repository would
 * otherwise be copied, substituted and committed as an app.
 */
export async function fetchTemplate(
  source: string | undefined,
  dir: string,
  options: FetchTemplateOptions = {},
): Promise<string> {
  const specifier = source ?? TEMPLATE_REPOSITORY;
  const download = options.download ?? defaultDownload;

  const target = path.resolve(dir);
  const { dir: fetched } = await download(specifier, { dir: target, force: true });

  if (!(await isTemplate(fetched))) {
    throw new TemplateError(
      `${specifier} has no ${TEMPLATE_MARKER}: it is not the hyperfixation template`,
    );
  }
  return fetched;
}

const defaultDownload: TemplateDownload = async (source, options) =>
  await downloadTemplate(source, { ...options, silent: true });

async function isTemplate(dir: string): Promise<boolean> {
  try {
    return (await stat(path.join(dir, TEMPLATE_MARKER))).isFile();
  } catch {
    return false;
  }
}
