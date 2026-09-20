import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Step } from "../new-cloud.js";
import { EXCLUDED_ENTRIES } from "../new.js";
import { gitHead, mustRun, short, type CloudStepContext } from "./context.js";

/**
 * `pnpm install`, then the app's own first commit.
 *
 * Done means `git rev-parse HEAD` answers, which is also how a run with no state file detects the
 * work of a previous one: the commit is the artefact, and a `node_modules` is not evidence of
 * anything.
 */
export const installStep: Step<CloudStepContext> = {
  name: "install",
  run: async (context) => {
    const { names } = context;
    const head = await gitHead(context);
    if (head !== undefined) {
      context.io.out(`${names.given}: adopting the commit already in ${context.dir} (${short(head)})`);
      return;
    }

    // Listed before `pnpm install`, so the paths handed to `git add` cannot include a
    // `node_modules` the lockfile install is about to create.
    const files = await templatedFiles(context.dir);

    await mustRun(context, "pnpm", ["install"]);
    await mustRun(context, "git", ["init", "-b", "main"]);
    // Explicit paths, never `git add -A`: the template's `.gitignore` is one of the files being
    // added and is therefore not in force yet, and `.env` is the file that must not be committed.
    await mustRun(context, "git", ["add", "--", ...files]);
    await mustRun(context, "git", [
      "commit",
      "-m",
      `Create ${names.given} from hyperfixation-template`,
    ]);

    context.io.out(`${names.given}: ${String(files.length)} file(s) in the initial commit`);
  },
};

/** Every file the template fetch left, relative to the app directory, `EXCLUDED_ENTRIES` aside. */
export async function templatedFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (EXCLUDED_ENTRIES.includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(path.relative(dir, full));
    }
  };
  await walk(dir);
  return found.sort();
}
