import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  httpRegistryClient,
  NPMJS_REGISTRY,
  packPackages,
  readFixedGroup,
  readGroupManifests,
  registryProblems,
  spawnExec,
  tarballIntegrity,
  versionMismatches,
  workspaceRangeLeftovers,
  type Exec,
  type PropagationWait,
  type RegistryClient,
} from "./registry.js";

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const USAGE = `Usage: pnpm release:verify <version> [--registry <url>] [--root <dir>]

The two checks a release needs whoever does the publishing: the release commit's fixed group is at
<version> with no workspace: ranges surviving \`pnpm pack\`, and every package's version document
on the registry exists with a dist.integrity matching a tarball packed from that commit. The
tarballs come from a throwaway worktree of the release commit, never from this checkout — build
output differs between an incremental tree and a clean one, and whatever branch happens to be out
is not what was published. This is what survives the cutover to the OIDC workflow — see the README.`;

export type VerifyOptions = {
  readonly version: string;
  readonly root: string;
  readonly registry: string;
};

export type VerifyDeps = {
  readonly exec: Exec;
  readonly registry: RegistryClient;
  readonly integrity: (tarball: string) => Promise<string>;
  readonly log: (line: string) => void;
  readonly wait?: PropagationWait;
};

export type ReleaseCommit = { readonly sha: string; readonly source: string };

function capture(exec: Exec, root: string, args: readonly string[]): string | undefined {
  const result = exec("git", args, { cwd: root, capture: true });
  const output = result.stdout.trim();
  return result.status === 0 && output !== "" ? output : undefined;
}

/**
 * The commit the release was cut from: its tag, else the last commit on origin/main that
 * introduced `"version": "<version>"` into a package manifest, else origin/main's tip.
 */
export function resolveReleaseCommit(
  exec: Exec,
  root: string,
  version: string,
): ReleaseCommit {
  for (const ref of [`refs/tags/v${version}`, `refs/tags/${version}`]) {
    const sha = capture(exec, root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (sha !== undefined) return { sha, source: ref };
  }
  const bump = capture(exec, root, [
    "log",
    "-1",
    "--format=%H",
    `-S"version": "${version}"`,
    "origin/main",
    "--",
    "packages/*/package.json",
  ]);
  if (bump !== undefined) return { sha: bump, source: `the ${version} bump on origin/main` };
  const tip = capture(exec, root, ["rev-parse", "--verify", "origin/main"]);
  if (tip === undefined) {
    throw new Error(`Could not resolve a release commit for ${version}: no tag and no origin/main`);
  }
  return { sha: tip, source: "origin/main" };
}

function must(exec: Exec, cwd: string, command: string, args: readonly string[]): void {
  if (exec(command, args, { cwd }).status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}`);
  }
}

/** Every problem found, not just the first: this is a diagnostic, not a gate on a publish. */
export async function verify(
  options: VerifyOptions,
  deps: VerifyDeps,
): Promise<string[]> {
  const commit = resolveReleaseCommit(deps.exec, options.root, options.version);
  const work = await mkdtemp(join(tmpdir(), "hf-verify-"));
  const checkout = join(work, "core");
  const tarballDir = join(work, "tarballs");
  deps.log(`commit:   ${commit.sha} (${commit.source})`);
  deps.log(`worktree: ${checkout}`);
  try {
    must(deps.exec, options.root, "git", ["worktree", "add", "--detach", checkout, commit.sha]);
    try {
      const group = await readFixedGroup(checkout);
      const manifests = await readGroupManifests(checkout, group);
      const mismatches = versionMismatches(manifests, options.version);
      if (mismatches.length > 0) {
        // Tarballs packed from another version are not comparable, so there is nothing to add.
        return [
          ...mismatches.map((problem) => `${problem} at ${commit.sha} (${commit.source})`),
          `Nothing was packed: ${commit.source} is not the ${options.version} release commit.`,
        ];
      }

      must(deps.exec, checkout, "pnpm", ["install", "--frozen-lockfile"]);
      must(deps.exec, checkout, "pnpm", ["-r", "build"]);

      const tarballs = packPackages(deps.exec, checkout, group, tarballDir);
      return [
        ...workspaceRangeLeftovers(deps.exec, checkout, tarballs),
        ...(await registryProblems(
          deps.registry,
          options.version,
          tarballs,
          deps.integrity,
          deps.wait ?? {},
        )),
      ];
    } finally {
      deps.exec("git", ["worktree", "remove", "--force", checkout], { cwd: options.root });
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      registry: { type: "string", default: NPMJS_REGISTRY },
      root: { type: "string", default: CORE_ROOT },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const options: VerifyOptions = {
    version: positionals[0],
    root: resolve(values.root),
    registry: values.registry,
  };
  const problems = await verify(options, {
    exec: spawnExec,
    registry: httpRegistryClient(options.registry),
    integrity: tarballIntegrity,
    log: (line) => console.log(line),
  });
  if (problems.length === 0) {
    console.log(`\n${options.version} checks out at the release commit and on ${options.registry}.`);
    return 0;
  }
  console.error(`\n${options.version}:\n  ${problems.join("\n  ")}`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
