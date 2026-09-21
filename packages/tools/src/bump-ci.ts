import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { CORE_ROOT } from "./proc.js";
import { capture, must, ReleaseError } from "./publish-ci.js";
import { redact } from "./redact.js";
import { spawnExec, type Exec } from "./registry.js";

const USAGE = `Usage: pnpm release:bump --repo <owner/repo> --version <version> [--root <dir>]

Opens the \`core-bump/<version>\` PR on ONE downstream repo. One repo per invocation because one
repo per token: \`.github/workflows/release.yml\` runs this as a matrix job whose
\`create-github-app-token\` step is scoped to that repo alone, so the clone it runs \`pnpm update\`
in cannot reach hyperfixation-core or any sibling app. A repo that refuses its bump fails its own
matrix job; \`fail-fast: false\` leaves the others to open theirs.

  --repo <owner/repo>  the downstream repo to bump
  --version <version>  the \`@hyperfixation/*\` version every dependency moves to
  --root <dir>         the core checkout the pre-checks run from (default: this one)

Environment: HF_BUMP_TOKEN — that repo's installation token, for git and \`gh\` alike.`;

const BOT_NAME = "hyperfixation-bot";
const BOT_EMAIL = "hyperfixation-bot@users.noreply.github.com";

export type BumpOptions = {
  readonly repo: string;
  readonly version: string;
  readonly root: string;
};

export type BumpDeps = {
  readonly exec: Exec;
  readonly log: (line: string) => void;
  /** The installation token for this one repo — nothing else in this process has write access. */
  readonly token: string;
};

/**
 * Credentials as a transient header instead of in the URL. `git -c` *before* the subcommand is
 * process-scoped: unlike `git clone -c`, it is never written to the clone's `.git/config`, so the
 * checkout `pnpm update` then runs in carries no credential at all.
 */
function authArgs(token: string): string[] {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.extraheader=AUTHORIZATION: basic ${basic}`];
}

/** `gh` reads the token from the environment, never from a flag. */
function gh(deps: BumpDeps, cwd: string, args: readonly string[]): string {
  const result = deps.exec("gh", args, {
    cwd,
    capture: true,
    env: { ...process.env, GH_TOKEN: deps.token },
  });
  if (result.status !== 0) throw new ReleaseError(redact(`gh ${args.join(" ")} failed`));
  return result.stdout;
}

async function hyperfixationDependencies(checkout: string): Promise<string[]> {
  const raw = JSON.parse(await readFile(join(checkout, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.keys({ ...raw.dependencies, ...raw.devDependencies })
    .filter((name) => name.startsWith("@hyperfixation/"))
    .sort();
}

const RANGE_PREFIX = /^[\^~=v><\s]*/u;

/** Every `@hyperfixation/*` mention the lockfile carries, as `name@version`. */
const LOCK_MENTION = /@hyperfixation\/(?<name>[a-z-]+)@(?<version>\d[^\s'":,()]*)/gu;

/**
 * What still names another version after the update — the check that would have caught the 0.1.8
 * bump, whose `package.json` kept `admin`, `auth` and `cli` at `^0.1.7`. The app's own
 * `core-version.test.ts` catches it too, but only after a broken PR has been opened.
 */
async function bumpLeftovers(checkout: string, version: string): Promise<string[]> {
  const raw = JSON.parse(await readFile(join(checkout, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const leftovers: string[] = [];
  for (const field of ["dependencies", "devDependencies"] as const) {
    for (const [name, spec] of Object.entries(raw[field] ?? {})) {
      if (!name.startsWith("@hyperfixation/")) continue;
      if (spec.replace(RANGE_PREFIX, "") !== version) {
        leftovers.push(`package.json ${field}["${name}"] is ${spec}, not ${version}`);
      }
    }
  }
  const lockfile = join(checkout, "pnpm-lock.yaml");
  if (existsSync(lockfile)) {
    for (const match of (await readFile(lockfile, "utf8")).matchAll(LOCK_MENTION)) {
      const { name, version: resolved } = match.groups as { name: string; version: string };
      if (resolved !== version) {
        leftovers.push(`pnpm-lock.yaml resolves @hyperfixation/${name} to ${resolved}`);
      }
    }
  }
  return [...new Set(leftovers)];
}

/**
 * The pnpmfile names pnpm 12.4.2 actually loads, probed against it: `.pnpmfile.js`, `pnpmfile.js`
 * and `pnpmfile.cjs` are read by no version this repo pins, so looking for them would only produce
 * refusals nothing asked for.
 */
const PNPMFILE_NAMES = [".pnpmfile.cjs", ".pnpmfile.mjs"] as const;

/**
 * The file pnpm would load as this checkout's pnpmfile, if it has one. `pnpm-workspace.yaml`'s
 * `pnpmfile:` setting points at any path and pnpm 12 honours it — the `.npmrc` spelling it no
 * longer does — so the two default names are not the whole surface.
 */
async function checkoutPnpmfile(checkout: string): Promise<string | undefined> {
  const workspace = join(checkout, "pnpm-workspace.yaml");
  if (existsSync(workspace)) {
    const configured = (parse(await readFile(workspace, "utf8")) as { pnpmfile?: unknown } | null)
      ?.pnpmfile;
    if (typeof configured === "string" && existsSync(join(checkout, configured))) return configured;
  }
  return PNPMFILE_NAMES.find((name) => existsSync(join(checkout, name)));
}

/**
 * One bump PR on one downstream repo, or nothing. Every `@hyperfixation/*` moves together —
 * a mixed set is a combination nothing was tested against — which is why the whole set goes to
 * one pinned `pnpm update` and the branch is named for the release rather than for a package.
 */
export async function bumpDownstream(
  options: BumpOptions,
  deps: BumpDeps,
): Promise<boolean> {
  const { repo, version, root } = options;
  const branch = `core-bump/${version}`;
  const url = `https://github.com/${repo}.git`;
  const auth = authArgs(deps.token);

  const heads = capture(deps.exec, root, "git", [
    ...auth,
    "ls-remote",
    "--heads",
    url,
    `refs/heads/${branch}`,
  ]);
  if (heads.trim() !== "") {
    deps.log(`bump      ${repo} already has ${branch}`);
    return false;
  }
  // A merged bump PR's branch is deleted, so `ls-remote` alone would reopen it.
  const prs = gh(deps, root, ["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", "number"]);
  if ((JSON.parse(prs.trim() === "" ? "[]" : prs) as unknown[]).length > 0) {
    deps.log(`bump      ${repo} already has a PR for ${branch}`);
    return false;
  }

  const work = await mkdtemp(join(tmpdir(), "hf-bump-"));
  const checkout = join(work, "app");
  try {
    must(deps.exec, root, "git", [...auth, "clone", "--depth", "1", url, checkout]);
    const names = await hyperfixationDependencies(checkout);
    if (names.length === 0) {
      deps.log(`bump      ${repo} depends on no @hyperfixation/* package`);
      return false;
    }
    // Before the update, because the update is what it would change the meaning of. Asserted
    // rather than assumed: no repo has one today, so nothing else would notice until a bump PR
    // opened red.
    const pnpmfile = await checkoutPnpmfile(checkout);
    if (pnpmfile !== undefined) {
      throw new ReleaseError(
        `${repo} has a ${pnpmfile}, and this bump has no safe way to run \`pnpm update\` there:\n` +
          "    without `--ignore-pnpmfile` that file runs here holding this job's token, which is\n" +
          "    the hole the flag closes; with it, the update skipped hooks that shape resolution,\n" +
          "    and for a `.pnpmfile.cjs` pnpm 12 also drops the lockfile's `pnpmfileChecksum`, so\n" +
          "    the app's own `pnpm install --frozen-lockfile` fails with\n" +
          "    ERR_PNPM_LOCKFILE_CONFIG_MISMATCH and the bump PR opens red and stays red.\n" +
          `    Bump ${repo} to ${version} by hand, or drop ${pnpmfile}.`,
      );
    }
    must(deps.exec, checkout, "git", ["checkout", "-b", branch]);
    // Moves the caret in package.json and the lockfile together. Pinned to the exact version
    // rather than `--latest`: an exact pin cannot quietly resolve the version the packument still
    // names. It resolves a version minutes old only because the app's `pnpm-workspace.yaml` keeps
    // `@hyperfixation/*` in `minimumReleaseAgeExclude`; without it pnpm 12 refuses anything
    // published under 24h ago.
    //
    // `--ignore-scripts --ignore-pnpmfile`: this is the app's code, and the update is the only
    // thing wanted from it. Without them, `.pnpmfile.cjs` and every dependency build script in
    // that repo run here, holding this job's token. `pnpm-guards.test.ts` pins both flags to the
    // pnpm in `packageManager`, and measures what `--ignore-pnpmfile` does to the lockfile — which
    // is why a checkout that has a pnpmfile at all is refused above instead of updated.
    must(deps.exec, checkout, "pnpm", [
      "update",
      `@hyperfixation/*@${version}`,
      "--ignore-scripts",
      "--ignore-pnpmfile",
    ]);
    const leftovers = await bumpLeftovers(checkout, version);
    if (leftovers.length > 0) {
      throw new ReleaseError(
        `${repo} is not wholly on ${version} after the update:\n    ${leftovers.join("\n    ")}`,
      );
    }
    if (capture(deps.exec, checkout, "git", ["status", "--porcelain"]).trim() === "") {
      deps.log(`bump      ${repo} is already at ${version}`);
      return false;
    }
    must(deps.exec, checkout, "git", [
      "-c",
      `user.name=${BOT_NAME}`,
      "-c",
      `user.email=${BOT_EMAIL}`,
      "commit",
      "-am",
      `Bump @hyperfixation/* to ${version}`,
    ]);
    must(deps.exec, checkout, "git", [...auth, "push", "origin", branch]);
    gh(deps, checkout, [
      "pr",
      "create",
      "--repo",
      repo,
      "--head",
      branch,
      "--title",
      `Bump @hyperfixation/* to ${version}`,
      "--body",
      `Every \`@hyperfixation/*\` package moved together to \`${version}\`, opened by hyperfixation-core's release run.\n\nThis app's own contract suite gates the merge. A red CI here means the release changed something this app depends on; read the failure before overriding it.`,
    ]);
    deps.log(`bump      ${repo} ${branch} opened`);
    return true;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      repo: { type: "string" },
      version: { type: "string" },
      root: { type: "string", default: CORE_ROOT },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.repo === undefined || values.version === undefined) {
    console.error(USAGE);
    return 1;
  }
  const token = process.env.HF_BUMP_TOKEN ?? "";
  if (token === "") {
    console.error(
      `No HF_BUMP_TOKEN for ${values.repo}: the bump job's \`create-github-app-token\` step must ` +
        "mint an installation token scoped to that repository, or the PR cannot be opened.",
    );
    return 1;
  }

  try {
    const opened = await bumpDownstream(
      { repo: values.repo, version: values.version, root: resolve(values.root) },
      { exec: spawnExec, log: (line) => console.log(line), token },
    );
    console.log(`\n${values.repo}: ${opened ? "bump PR opened" : "left alone"}`);
    return 0;
  } catch (error) {
    if (error instanceof ReleaseError) {
      console.error(`\n${redact(error.message)}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
