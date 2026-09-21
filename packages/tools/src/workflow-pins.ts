import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const GITHUB = path.join(REPO_ROOT, ".github");

/**
 * `<owner>/<repo>` → pinned commit → the tag that commit is. Committed beside the workflows and
 * maintained with them: `workflow-pins.test.ts` fails a pin missing from it or labelled
 * differently, which is what a right-looking `# v4.4.0` beside a wrong SHA used to slip past, and
 * `pnpm pins:verify` resolves each entry against GitHub.
 */
export type PinTable = Record<string, Record<string, string>>;

export function pinTable(): PinTable {
  return JSON.parse(readFileSync(path.join(HERE, "workflow-pins.json"), "utf8")) as PinTable;
}

/** A `uses:` line, wherever in the file it sits. */
const USES = /^\s*(?:-\s*)?uses:\s*(?<ref>\S+)(?<rest>.*)$/gmu;

export const PINNED = /@(?<sha>[0-9a-f]{40})$/u;
export const VERSION_COMMENT = /^\s*#\s*(?<version>v\d+\.\d+\.\d+)/u;

export type Use = {
  /** Repo-relative, so a failure says which file to open. */
  readonly file: string;
  readonly ref: string;
  readonly rest: string;
};

/**
 * Every workflow and composite action under `.github`. `.yaml` is as valid a spelling as `.yml`,
 * and a composite action runs with the privileges of the job that calls it, so an unpinned `uses:`
 * in `.github/actions/<name>/action.yml` is worth as much to an attacker as one in a workflow.
 */
function sources(): string[] {
  const found: string[] = [];
  const workflows = path.join(GITHUB, "workflows");
  if (existsSync(workflows)) {
    for (const name of readdirSync(workflows)) {
      if (/\.ya?ml$/u.test(name)) found.push(path.join(workflows, name));
    }
  }
  const actions = path.join(GITHUB, "actions");
  if (existsSync(actions)) {
    for (const entry of readdirSync(actions, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /^action\.ya?ml$/u.test(entry.name)) {
        found.push(path.join(entry.parentPath, entry.name));
      }
    }
  }
  return found;
}

export function uses(): Use[] {
  const found: Use[] = [];
  for (const file of sources()) {
    for (const match of readFileSync(file, "utf8").matchAll(USES)) {
      const { ref, rest } = match.groups as { ref: string; rest: string };
      found.push({ file: path.relative(REPO_ROOT, file), ref, rest });
    }
  }
  return found;
}

/** A local action is this repo's own code at this repo's own commit; there is nothing to pin. */
export function thirdParty(use: Use): boolean {
  return !use.ref.startsWith("./");
}

/** The `<owner>/<repo>` a ref names — ignoring any subdirectory, and the pin itself. */
export function actionRepo(ref: string): string {
  return ref.split("@")[0].split("/").slice(0, 2).join("/");
}

export function pinnedSha(use: Use): string | undefined {
  return PINNED.exec(use.ref)?.groups?.sha;
}

export function commentVersion(use: Use): string | undefined {
  return VERSION_COMMENT.exec(use.rest)?.groups?.version;
}
