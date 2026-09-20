import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseDownstream } from "./downstream-matrix.js";
import {
  httpRegistryClient,
  NPMJS_REGISTRY,
  packPackages,
  readFixedGroup,
  readGroupManifests,
  registryProblems,
  spawnExec,
  tarballIntegrity,
  topologicalOrder,
  versionMismatches,
  workspaceRangeLeftovers,
  type Exec,
  type PropagationWait,
  type RegistryClient,
} from "./registry.js";

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const USAGE = `Usage: pnpm release:ci [--dry-run] [--registry <url>] [--root <dir>]

The publish step of \`.github/workflows/release.yml\`, run by \`changesets/action\` once the
\`Version Packages\` PR has merged. Unlike \`release:publish\` it takes no version and no
confirmation: the checkout it runs in *is* the release commit, and the version is whatever the
fixed group's manifests say. The credential is the OIDC token \`npm publish --provenance\` mints
per run, so there is no token to pass and none to leak.

  --dry-run          \`npm publish --dry-run\`; no verification, no tag, no bump PRs
  --registry <url>   check this registry instead of ${NPMJS_REGISTRY}
  --root <dir>       the checkout to release (default: this one)

A push to main that carries no changesets re-runs this against a version the registry already
has in full; it exits 0 having published, tagged and opened nothing.`;

const BOT_NAME = "hyperfixation-bot";
const BOT_EMAIL = "hyperfixation-bot@users.noreply.github.com";

export class ReleaseError extends Error {}

export type ReleaseCIOptions = {
  readonly root: string;
  readonly registry: string;
  readonly dryRun: boolean;
};

export type ReleaseCIDeps = {
  readonly exec: Exec;
  readonly registry: RegistryClient;
  readonly integrity: (tarball: string) => Promise<string>;
  readonly log: (line: string) => void;
  /** The bot App's installation token: clones, pushes and `gh` calls on the downstream repos. */
  readonly token: string;
  readonly wait?: PropagationWait;
};

export type ReleaseCIResult = {
  readonly version: string;
  readonly published: readonly string[];
  readonly skipped: readonly string[];
  readonly tagged: string | undefined;
  /** Downstream repos a `core-bump/<version>` PR was opened on. */
  readonly bumped: readonly string[];
  /** Downstream repos left alone — already bumped, or already carrying the branch or the PR. */
  readonly untouched: readonly string[];
};

function must(exec: Exec, cwd: string, command: string, args: readonly string[]): void {
  if (exec(command, args, { cwd }).status !== 0) {
    throw new ReleaseError(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
}

function capture(exec: Exec, cwd: string, command: string, args: readonly string[]): string {
  const result = exec(command, args, { cwd, capture: true });
  if (result.status !== 0) {
    throw new ReleaseError(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
  return result.stdout;
}

/** `gh` reads the bot token from the environment, never from a flag. */
function gh(deps: ReleaseCIDeps, cwd: string, args: readonly string[]): string {
  const result = deps.exec("gh", args, {
    cwd,
    capture: true,
    env: { ...process.env, GH_TOKEN: deps.token },
  });
  if (result.status !== 0) throw new ReleaseError(`gh ${args.join(" ")} failed`);
  return result.stdout;
}

/** Absent file means no downstream; `parseDownstream` is the same reader CI builds its matrix from. */
export async function readDownstream(root: string): Promise<string[]> {
  const file = join(root, "downstream.txt");
  if (!existsSync(file)) return [];
  return parseDownstream(await readFile(file, "utf8"));
}

function cloneUrl(repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${repo}.git`;
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

/**
 * One bump PR on one downstream repo, or nothing. Every `@hyperfixation/*` moves together —
 * a mixed set is a combination nothing was tested against — which is why the whole set goes to
 * `pnpm update --latest` and the branch is named for the release rather than for a package.
 */
async function bumpDownstream(
  repo: string,
  version: string,
  deps: ReleaseCIDeps,
  root: string,
): Promise<boolean> {
  const branch = `core-bump/${version}`;
  const url = cloneUrl(repo, deps.token);

  const heads = capture(deps.exec, root, "git", ["ls-remote", "--heads", url, `refs/heads/${branch}`]);
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
    must(deps.exec, root, "git", ["clone", "--depth", "1", url, checkout]);
    const names = await hyperfixationDependencies(checkout);
    if (names.length === 0) {
      deps.log(`bump      ${repo} depends on no @hyperfixation/* package`);
      return false;
    }
    must(deps.exec, checkout, "git", ["checkout", "-b", branch]);
    // Moves the caret in package.json and the lockfile together. It resolves a version minutes
    // old only because the app's `pnpm-workspace.yaml` keeps `@hyperfixation/*` in
    // `minimumReleaseAgeExclude`; without it pnpm 12 refuses anything published under 24h ago.
    must(deps.exec, checkout, "pnpm", ["update", "--latest", ...names]);
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
    must(deps.exec, checkout, "git", ["push", "origin", branch]);
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

export async function releaseCI(
  options: ReleaseCIOptions,
  deps: ReleaseCIDeps,
): Promise<ReleaseCIResult> {
  const group = await readFixedGroup(options.root);
  const manifests = await readGroupManifests(options.root, group);
  const version = manifests[0].version;
  if (version === "") throw new ReleaseError(`${manifests[0].name} has no version`);
  const mismatches = versionMismatches(manifests, version);
  if (mismatches.length > 0) {
    throw new ReleaseError(
      `The fixed group does not agree on a version:\n  ${mismatches.join("\n  ")}\n` +
        "`pnpm changeset version` moves them together; this checkout was edited by hand.",
    );
  }

  const order = topologicalOrder(manifests);
  const already = new Set<string>();
  for (const name of order) {
    if ((await deps.registry.versionDocument(name, version)).status === 200) already.add(name);
  }
  // The no-changesets push: main moved, the group is still at a version the registry has in
  // full, and a release run must be a no-op rather than a re-tag and a second round of bump PRs.
  if (already.size === order.length) {
    deps.log(`${version} is already on ${deps.registry.url} in full — nothing to do.`);
    return { version, published: [], skipped: order, tagged: undefined, bumped: [], untouched: [] };
  }

  const work = await mkdtemp(join(tmpdir(), "hf-release-ci-"));
  const tarballDir = join(work, "tarballs");
  try {
    must(deps.exec, options.root, "pnpm", ["-r", "build"]);
    const tarballs = packPackages(deps.exec, options.root, group, tarballDir);
    const leftovers = workspaceRangeLeftovers(deps.exec, options.root, tarballs);
    if (leftovers.length > 0) {
      throw new ReleaseError(`Packed manifests still carry workspace: ranges:\n  ${leftovers.join("\n  ")}`);
    }

    const published: string[] = [];
    const skipped: string[] = [];
    for (const name of order) {
      const tarball = tarballs.get(name);
      if (tarball === undefined) throw new ReleaseError(`${name} was not packed`);
      if (already.has(name)) {
        deps.log(`skip      ${name}@${version} is already published`);
        skipped.push(name);
        continue;
      }
      deps.log(`publish   ${name}@${version}`);
      must(deps.exec, options.root, "npm", [
        "publish",
        tarball,
        "--provenance",
        "--access",
        "public",
        ...(options.dryRun ? ["--dry-run"] : []),
      ]);
      published.push(name);
    }

    if (options.dryRun) {
      deps.log("\n--dry-run: not verifying, not tagging, opening no bump PRs.");
      return { version, published, skipped, tagged: undefined, bumped: [], untouched: [] };
    }

    const problems = await registryProblems(
      deps.registry,
      version,
      tarballs,
      deps.integrity,
      deps.wait ?? {},
    );
    if (problems.length > 0) {
      throw new ReleaseError(`Published, but the registry does not agree:\n  ${problems.join("\n  ")}`);
    }
    deps.log(`\nAll ${tarballs.size} version documents match the tarballs packed from this commit.`);

    // `fetch-depth: 0` brings the tags, so the local ref is the answer for the remote too.
    const tag = `v${version}`;
    const exists =
      deps.exec("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], {
        cwd: options.root,
        capture: true,
      }).status === 0;
    if (exists) deps.log(`tag       ${tag} already exists`);
    else {
      must(deps.exec, options.root, "git", ["tag", tag]);
      must(deps.exec, options.root, "git", ["push", "origin", tag]);
      deps.log(`tag       ${tag} pushed`);
    }

    const downstream = await readDownstream(options.root);
    if (downstream.length > 0 && deps.token === "") {
      throw new ReleaseError(
        "downstream.txt names repositories but no bot token was passed: GITHUB_TOKEN must carry " +
          "the hyperfixation-bot App's installation token, or the bump PRs cannot be opened.",
      );
    }
    const bumped: string[] = [];
    const untouched: string[] = [];
    for (const repo of downstream) {
      if (await bumpDownstream(repo, version, deps, options.root)) bumped.push(repo);
      else untouched.push(repo);
    }

    return { version, published, skipped, tagged: exists ? undefined : tag, bumped, untouched };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      registry: { type: "string", default: NPMJS_REGISTRY },
      root: { type: "string", default: CORE_ROOT },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const options: ReleaseCIOptions = {
    root: resolve(values.root),
    registry: values.registry,
    dryRun: values["dry-run"],
  };
  try {
    const result = await releaseCI(options, {
      exec: spawnExec,
      registry: httpRegistryClient(options.registry),
      integrity: tarballIntegrity,
      log: (line) => console.log(line),
      token: process.env.GITHUB_TOKEN ?? "",
    });
    console.log(
      `\n${result.version}: published ${result.published.length}, skipped ${result.skipped.length}` +
        `, tag ${result.tagged ?? "(unchanged)"}, bump PRs ${result.bumped.length}`,
    );
    return 0;
  } catch (error) {
    if (error instanceof ReleaseError) {
      console.error(`\n${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
