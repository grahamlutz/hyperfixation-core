import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classify, classifyRepo, parseWorktrees, repoSlug, type Candidate } from "./worktrees.js";

/**
 * `gh pr list --state merged --head <branch>`, answered from FAKE_GH_MERGED (`branch:oid` pairs)
 * — the classifier's merge signal is a GitHub answer, so the fixture has to supply one.
 */
const FAKE_GH = `#!/bin/sh
head=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--head" ]; then head="$2"; fi
  shift
done
for entry in $FAKE_GH_MERGED; do
  if [ "\${entry%%:*}" = "$head" ]; then
    printf '[{"number":7,"headRefOid":"%s"}]' "\${entry#*:}"
    exit 0
  fi
done
printf '[]'
`;

/**
 * `origin` stays the fixture's own bare repo for the whole file, and `repoSlug` is exercised on
 * a repo of its own below: a fixture that both pushes and carries a github.com origin pushes its
 * branches to the real repository, which is exactly what happened the first time this ran.
 */
let work: string;
let main: string;
let env: NodeJS.ProcessEnv;

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function touch(cwd: string, name: string): void {
  writeFileSync(join(cwd, `${name}.txt`), `${name}\n`);
}

function commit(cwd: string, message: string): string {
  touch(cwd, message);
  git(["add", `${message}.txt`], cwd);
  git(["commit", "-m", message], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}

/** A branch in its own worktree, pushed, optionally with its remote ref deleted afterwards. */
function branchWorktree(name: string, options: { deleteRemoteRef?: boolean } = {}): string {
  const path = join(work, name);
  git(["worktree", "add", "-b", name, path], main);
  const head = commit(path, name);
  git(["push", "-u", "origin", name], path);
  if (options.deleteRemoteRef === true) {
    git(["push", "origin", "--delete", name], path);
    git(["fetch", "--prune"], path);
  }
  return head;
}

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "hf-worktrees-test-"));
  const remote = join(work, "remote.git");
  const seed = join(work, "seed");
  main = join(work, "main");

  git(["init", "--bare", "-b", "main", remote], work);
  git(["clone", remote, seed], work);
  git(["config", "user.email", "test@example.com"], seed);
  git(["config", "user.name", "Test"], seed);
  commit(seed, "seed");
  git(["push", "origin", "main"], seed);
  git(["clone", remote, main], work);
  git(["config", "user.email", "test@example.com"], main);
  git(["config", "user.name", "Test"], main);

  const mergedClean = branchWorktree("merged-clean");
  // The squash-merge shape: GitHub deleted the remote branch, so nothing but the PR says merged.
  const mergedSquashed = branchWorktree("merged-squashed", { deleteRemoteRef: true });
  const mergedDirty = branchWorktree("merged-dirty");
  const mergedUnpushed = branchWorktree("merged-unpushed");
  branchWorktree("unmerged");

  touch(join(work, "merged-dirty"), "uncommitted");
  commit(join(work, "merged-unpushed"), "review-fix");

  const bin = join(work, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    FAKE_GH_MERGED: [
      `merged-clean:${mergedClean}`,
      `merged-squashed:${mergedSquashed}`,
      `merged-dirty:${mergedDirty}`,
      `merged-unpushed:${mergedUnpushed}`,
    ].join(" "),
  };
}, 60_000);

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("parseWorktrees", () => {
  it("reads the porcelain records and marks the first as the main checkout", () => {
    const porcelain = [
      "worktree /Users/x/Code/hyperfixation",
      "HEAD 4c5e92f0e452316db458de8adb9b775be89a6712",
      "branch refs/heads/main",
      "",
      "worktree /Users/x/Code/hf-core-release-0-1-0",
      "HEAD 7087410b0a7563a95be47b99bd72871552649ba9",
      "branch refs/heads/release-0-1-0",
      "",
      "worktree /Users/x/Code/detached",
      "HEAD 5405af4efd48feaed66d2eb3c00da0b756f91df0",
      "detached",
      "",
    ].join("\n");

    expect(parseWorktrees(porcelain)).toEqual([
      {
        path: "/Users/x/Code/hyperfixation",
        head: "4c5e92f0e452316db458de8adb9b775be89a6712",
        branch: "main",
        main: true,
      },
      {
        path: "/Users/x/Code/hf-core-release-0-1-0",
        head: "7087410b0a7563a95be47b99bd72871552649ba9",
        branch: "release-0-1-0",
        main: false,
      },
      {
        path: "/Users/x/Code/detached",
        head: "5405af4efd48feaed66d2eb3c00da0b756f91df0",
        branch: undefined,
        main: false,
      },
    ]);
  });
});

describe("repoSlug", () => {
  it.each([
    ["https://github.com/grahamlutz/hyperfixation-core.git", "grahamlutz/hyperfixation-core"],
    ["git@github.com:grahamlutz/hyperfixation-template.git", "grahamlutz/hyperfixation-template"],
  ])("reads %s as the --repo argument", async (url, slug) => {
    const dir = await mkdtemp(join(tmpdir(), "hf-slug-test-"));
    git(["init", "-b", "main", dir], dir);
    git(["remote", "add", "origin", url], dir);

    expect(repoSlug(dir)).toBe(slug);

    await rm(dir, { recursive: true, force: true });
  });
});

describe("classify", () => {
  const worktree = { path: "/w", head: "abc", branch: "b", main: false };

  it("keeps a worktree whose gh lookup failed", () => {
    const facts = { dirty: false, unpushed: 0, error: "gh pr list failed: boom" };

    expect(classify(worktree, facts)).toEqual({
      removable: false,
      reason: "gh pr list failed: boom",
    });
  });
});

describe("classifyRepo over a fixture repo", () => {
  let candidates: Candidate[];
  const reasonOf = (branch: string): string =>
    candidates.find((candidate) => candidate.worktree.branch === branch)?.reason ?? "missing";
  const removableOf = (branch: string): boolean | undefined =>
    candidates.find((candidate) => candidate.worktree.branch === branch)?.removable;

  beforeAll(async () => {
    candidates = (await classifyRepo(main, env)).candidates;
  }, 60_000);

  it("removes a merged branch that is clean and pushed", () => {
    expect(removableOf("merged-clean")).toBe(true);
    expect(reasonOf("merged-clean")).toBe("PR #7 merged");
  });

  it("removes a merged branch whose remote ref the squash merge deleted", () => {
    expect(removableOf("merged-squashed")).toBe(true);
  });

  it("keeps the main checkout", () => {
    expect(removableOf("main")).toBe(false);
    expect(reasonOf("main")).toBe("main checkout");
  });

  it("keeps a merged branch with uncommitted changes", () => {
    expect(removableOf("merged-dirty")).toBe(false);
    expect(reasonOf("merged-dirty")).toContain("uncommitted changes");
  });

  it("keeps a merged branch with a commit the PR never saw", () => {
    expect(removableOf("merged-unpushed")).toBe(false);
    expect(reasonOf("merged-unpushed")).toContain("unpushed commit");
  });

  it("keeps a branch with no merged PR", () => {
    expect(removableOf("unmerged")).toBe(false);
    expect(reasonOf("unmerged")).toBe("no merged PR");
  });
});
