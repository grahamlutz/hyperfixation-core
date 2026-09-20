import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { capture } from "./proc.js";

const execFileAsync = promisify(execFile);

/** `gh` calls are one process each and there are ~80 worktrees on this machine. */
const GH_CONCURRENCY = 8;

export interface Worktree {
  path: string;
  head: string;
  /** Absent for a detached or bare worktree. */
  branch?: string;
  /** The checkout the others hang off; `git worktree remove` refuses it and so do we. */
  main: boolean;
}

/** `git worktree list --porcelain`: one blank-line-separated record per worktree, main first. */
export function parseWorktrees(porcelain: string): Worktree[] {
  const worktrees: Worktree[] = [];
  for (const record of porcelain.trim().split(/\n\s*\n/)) {
    let path: string | undefined;
    let head = "";
    let branch: string | undefined;
    for (const line of record.split("\n")) {
      const [key, ...rest] = line.trim().split(" ");
      const value = rest.join(" ");
      if (key === "worktree") path = value;
      else if (key === "HEAD") head = value;
      else if (key === "branch") branch = value.replace(/^refs\/heads\//, "");
    }
    if (path === undefined) continue;
    worktrees.push({ path, head, branch, main: worktrees.length === 0 });
  }
  return worktrees;
}

export interface MergedPr {
  number: number;
  headRefOid: string;
}

export interface WorktreeFacts {
  dirty: boolean;
  /** Commits reachable from HEAD and from no remote ref. */
  unpushed: number;
  mergedPr?: MergedPr;
  /** `gh` or `git` could not answer; never removable. */
  error?: string;
}

export interface Classification {
  removable: boolean;
  reason: string;
}

/**
 * Removable only when `gh` found a merged PR for the branch, the worktree is clean, and nothing
 * is unpushed. The merged PR is the only usable merge signal: core and the template squash, so
 * `git merge-base --is-ancestor` reports almost no merged branch as merged (1 of 55 when the
 * plan checked). A HEAD matching the merged PR's head is pushed by definition, which is what
 * makes a branch whose remote ref GitHub deleted on merge still classify as clean.
 */
export function classify(worktree: Worktree, facts: WorktreeFacts): Classification {
  if (worktree.main) return { removable: false, reason: "main checkout" };
  if (worktree.branch === undefined) return { removable: false, reason: "detached HEAD" };
  if (facts.error !== undefined) return { removable: false, reason: facts.error };
  if (facts.mergedPr === undefined) return { removable: false, reason: "no merged PR" };
  if (facts.dirty)
    return {
      removable: false,
      reason: `uncommitted changes (PR #${facts.mergedPr.number} merged)`,
    };
  if (facts.unpushed > 0 && worktree.head !== facts.mergedPr.headRefOid) {
    return {
      removable: false,
      reason: `${facts.unpushed} unpushed commit(s) (PR #${facts.mergedPr.number} merged)`,
    };
  }
  return { removable: true, reason: `PR #${facts.mergedPr.number} merged` };
}

export interface Candidate extends Classification {
  worktree: Worktree;
}

export interface RepoReport {
  repoDir: string;
  slug: string;
  candidates: Candidate[];
}

/** Every worktree of `repoDir` with the reason it is or is not removable. Reads only. */
export async function classifyRepo(
  repoDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RepoReport> {
  const worktrees = listWorktrees(repoDir);
  const slug = repoSlug(repoDir);
  const branches = worktrees.flatMap((worktree) =>
    !worktree.main && worktree.branch !== undefined ? [worktree.branch] : [],
  );
  const pullRequests = await mergedPullRequests(slug, branches, env);

  const candidates = worktrees.map((worktree) => {
    if (worktree.main || worktree.branch === undefined) {
      return { worktree, ...classify(worktree, { dirty: false, unpushed: 0 }) };
    }
    const { pr, error } = pullRequests.get(worktree.branch) ?? {};
    const local = localFacts(worktree);
    const facts = { ...local, mergedPr: pr, error: error ?? local.error };
    return { worktree, ...classify(worktree, facts) };
  });
  return { repoDir, slug, candidates };
}

export function listWorktrees(repoDir: string): Worktree[] {
  const result = capture("git", ["-C", repoDir, "worktree", "list", "--porcelain"]);
  if (!result.ok)
    throw new Error(`git worktree list failed in ${repoDir}: ${result.stderr.trim()}`);
  return parseWorktrees(result.stdout);
}

export function repoSlug(repoDir: string): string {
  const result = capture("git", ["-C", repoDir, "remote", "get-url", "origin"]);
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\s*$/.exec(result.stdout);
  if (match?.[1] === undefined) throw new Error(`no origin remote in ${repoDir}`);
  return match[1];
}

export function localFacts(
  worktree: Worktree,
): Pick<WorktreeFacts, "dirty" | "unpushed" | "error"> {
  const status = capture("git", ["-C", worktree.path, "status", "--porcelain"]);
  if (!status.ok) return { dirty: true, unpushed: 0, error: "git status failed" };
  const unpushed = capture("git", [
    "-C",
    worktree.path,
    "rev-list",
    "--count",
    "HEAD",
    "--not",
    "--remotes",
  ]);
  return {
    dirty: status.stdout.trim().length > 0,
    unpushed: unpushed.ok ? Number(unpushed.stdout.trim()) : 1,
    error: unpushed.ok ? undefined : "git rev-list failed",
  };
}

export interface PrLookup {
  pr?: MergedPr;
  error?: string;
}

/** One `gh pr list --head <branch>` per branch, a few at a time. */
export async function mergedPullRequests(
  slug: string,
  branches: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, PrLookup>> {
  const queue = [...new Set(branches)];
  const found = new Map<string, PrLookup>();
  const workers = Array.from({ length: Math.min(GH_CONCURRENCY, queue.length) }, async () => {
    for (let branch = queue.shift(); branch !== undefined; branch = queue.shift()) {
      found.set(branch, await mergedPullRequest(slug, branch, env));
    }
  });
  await Promise.all(workers);
  return found;
}

async function mergedPullRequest(
  slug: string,
  branch: string,
  env: NodeJS.ProcessEnv,
): Promise<PrLookup> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        slug,
        "--state",
        "merged",
        "--head",
        branch,
        "--limit",
        "1",
        "--json",
        "number,headRefOid",
      ],
      { env },
    );
    const [pr] = JSON.parse(stdout) as MergedPr[];
    return { pr };
  } catch (error) {
    return {
      error: `gh pr list failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
    };
  }
}

/** `git worktree remove`, then the branch — in that order, since the branch is checked out. */
export function removeWorktree(repoDir: string, worktree: Worktree): string | undefined {
  const removed = capture("git", ["-C", repoDir, "worktree", "remove", worktree.path]);
  if (!removed.ok) return `git worktree remove failed: ${removed.stderr.trim()}`;
  if (worktree.branch === undefined) return undefined;
  const deleted = capture("git", ["-C", repoDir, "branch", "-D", worktree.branch]);
  return deleted.ok ? undefined : `git branch -D failed: ${deleted.stderr.trim()}`;
}
