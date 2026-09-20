import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { cp } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { deriveNames, type AppNames } from "./names.js";

/**
 * The file that marks a directory as a copy source. `hf new`'s first act on the source is to
 * assert it exists; its last act on the copy is to delete it, so an app is never a template
 * twice.
 */
export const TEMPLATE_MARKER = ".hyperfixation-template";

/**
 * Not copied. Build output and `node_modules` belong to the source checkout, `.git` would make
 * the new app a clone of the template's history rather than a repository of its own, and `.env`
 * is the one file in the tree that may hold a secret.
 */
export const EXCLUDED_ENTRIES: readonly string[] = [
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "out",
  ".env",
  "tsconfig.tsbuildinfo",
  "next-env.d.ts",
];

/** Extensions copied byte for byte; everything else is read as UTF-8 and substituted. */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".pdf",
  ".zip",
]);

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export interface NewAppOptions {
  /** The name as typed; becomes the directory and, underscored, both placeholders. */
  name: string;
  /** The template checkout to copy. */
  from: string;
  /** Where the app directory is created. Defaults to the current working directory. */
  into?: string;
  /**
   * Phase 1 is local only. Passing `false` is refused rather than ignored, because the cloud
   * `hf new` provisions GitHub, Postgres, Coolify and Cloudflare and a half-provisioned app is
   * worse than none.
   */
  local: boolean;
  /** The bootstrap admin's address, written to `.env` as `HF_BOOTSTRAP_EMAIL`. Skips the prompt. */
  email?: string;
  /** Overrides the real interactive prompt; for tests and other callers with their own stdin. */
  promptEmail?: () => Promise<string>;
}

export interface NewAppResult extends AppNames {
  /** Absolute path of the created app. */
  dir: string;
  /** Files whose contents a placeholder substitution changed. */
  substituted: readonly string[];
  /** True when `.env` was written from `.env.example`. */
  wroteEnv: boolean;
  /** True when `HF_BOOTSTRAP_EMAIL` was written to `.env`, from `--email` or the prompt. */
  wroteBootstrapEmail: boolean;
}

/**
 * Copies the template checkout and substitutes the two placeholders across it.
 *
 * This is giget's semantics against a local directory rather than giget itself: Phase 1's
 * source is the sibling `hyperfixation-template` checkout, which giget's providers do not
 * address at all (it resolves `gh:`/`gitlab:`/tarball URLs), and `--local` is the only mode
 * that exists until Phase 3. The remote fetch is that phase's to add, beside the provisioning
 * steps that are the rest of a cloud `hf new`.
 */
export async function newApp(options: NewAppOptions): Promise<NewAppResult> {
  if (!options.local) {
    throw new TemplateError(
      "hf new needs --local: provisioning GitHub, Postgres, Coolify and Cloudflare is Phase 3",
    );
  }

  const names = deriveNames(options.name);
  const source = path.resolve(options.from);
  await assertTemplateSource(source);

  const dir = path.resolve(options.into ?? process.cwd(), names.given);
  if (await exists(dir)) {
    throw new TemplateError(`${dir} already exists; hf new will not write into it`);
  }

  await cp(source, dir, {
    recursive: true,
    filter: (src) => !EXCLUDED_ENTRIES.includes(path.basename(src)),
  });

  const substituted = await substituteTree(dir, names);
  await rm(path.join(dir, TEMPLATE_MARKER));

  const example = path.join(dir, ".env.example");
  const wroteEnv = await exists(example);
  let wroteBootstrapEmail = false;
  if (wroteEnv) {
    let contents = await readFile(example, "utf8");
    const email = options.email ?? (await (options.promptEmail ?? promptForBootstrapEmail)());
    if (email !== "") {
      contents = `${contents.trimEnd()}\nHF_BOOTSTRAP_EMAIL=${email}\n`;
      wroteBootstrapEmail = true;
    }
    await writeFile(path.join(dir, ".env"), contents);
  }

  return { ...names, dir, substituted, wroteEnv, wroteBootstrapEmail };
}

/** The one-time prompt: the address `hf up` later hands `hf bootstrap` via `.env`. */
async function promptForBootstrapEmail(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question("bootstrap admin email (blank to skip): ")).trim();
  } finally {
    rl.close();
  }
}

/** The placeholder map. Exported because `hf check` reports a leftover placeholder by name. */
export function placeholders(names: AppNames): Record<string, string> {
  return { __APP_NAME__: names.appName, __DB_NAME__: names.databaseName };
}

export function substitute(contents: string, names: AppNames): string {
  let out = contents;
  for (const [token, value] of Object.entries(placeholders(names))) {
    out = out.replaceAll(token, value);
  }
  return out;
}

async function assertTemplateSource(source: string): Promise<void> {
  if (!(await exists(source))) {
    throw new TemplateError(`template source ${source} does not exist`);
  }
  if (!(await exists(path.join(source, TEMPLATE_MARKER)))) {
    throw new TemplateError(
      `${source} has no ${TEMPLATE_MARKER}: it is not a hyperfixation template checkout`,
    );
  }
}

/** Substitutes every placeholder in a copied tree; the cloud `template` step reuses this one. */
export async function substituteTree(dir: string, names: AppNames): Promise<string[]> {
  const changed: string[] = [];
  for (const file of await walk(dir)) {
    if (BINARY_EXTENSIONS.has(path.extname(file))) continue;
    const before = await readFile(file, "utf8");
    const after = substitute(before, names);
    if (after === before) continue;
    await writeFile(file, after);
    changed.push(path.relative(dir, file));
  }
  return changed.sort();
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
