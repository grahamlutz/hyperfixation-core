import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { capture, mainCheckout, templateDir } from "./proc.js";
import { classifyRepo, removeWorktree } from "./worktrees.js";

const USAGE = `Usage: pnpm worktrees:clean [--yes]

Removes the worktrees of branches whose pull request GitHub has already merged, in this
checkout and in the template's. Prints what it would remove and changes nothing unless --yes
is given.

  --yes   actually \`git worktree remove\`, \`git branch -D\` and \`git worktree prune\`

A worktree is removable only when \`gh pr list --state merged --head <branch>\` returns a PR
and the worktree has no uncommitted changes and no unpushed commits. The main checkout is
never removed.

Environment: HF_TEMPLATE_DIR (default ../hyperfixation-template).`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      yes: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const repos = [mainCheckout(), templateDir()].filter((dir) => existsSync(join(dir, ".git")));
  let failed = false;

  for (const repoDir of repos) {
    const { slug, candidates } = await classifyRepo(repoDir);
    console.log(`\n${slug}  (${repoDir})  ${candidates.length} worktrees`);
    for (const { worktree, removable, reason } of candidates) {
      console.log(
        `  ${removable ? "REMOVE" : "keep  "} ${worktree.branch ?? "(detached)"} — ${reason}`,
      );
    }

    const removable = candidates.filter((candidate) => candidate.removable);
    console.log(`  ${removable.length} of ${candidates.length} removable`);
    if (!values.yes) continue;

    for (const { worktree } of removable) {
      const error = removeWorktree(repoDir, worktree);
      if (error !== undefined) {
        failed = true;
        console.error(`  FAILED ${worktree.path}: ${error}`);
      }
    }
    const pruned = capture("git", ["-C", repoDir, "worktree", "prune"]);
    if (!pruned.ok) {
      failed = true;
      console.error(`  FAILED git worktree prune: ${pruned.stderr.trim()}`);
    }
  }

  if (!values.yes) console.log("\ndry run — nothing was removed; pass --yes to act");
  return failed ? 1 : 0;
}

process.exitCode = await main();
