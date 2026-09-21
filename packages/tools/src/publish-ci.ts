import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseDownstream } from "./downstream-matrix.js";
import { redact } from "./redact.js";
import {
  awaitInstallable,
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
  type PackumentRegistryClient,
  type PropagationWait,
} from "./registry.js";

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const USAGE = `Usage: pnpm release:ci [--dry-run] [--registry <url>] [--root <dir>] [--result <file>]

The publish step of \`.github/workflows/release.yml\`, run by \`changesets/action\` once the
\`Version Packages\` PR has merged. Unlike \`release:publish\` it takes no version and no
confirmation: the checkout it runs in *is* the release commit, and the version is whatever the
fixed group's manifests say. The credential is the OIDC token \`npm publish --provenance\` mints
per run, so there is no token to pass and none to leak.

The downstream bump PRs are not opened here — \`release:bump\` opens them, one job per repo with
a token scoped to that repo alone, so a compromised app repo cannot reach this job's npm identity.

  --dry-run          \`npm publish --dry-run\`; no verification, no tag, no bump PRs
  --recover          finish a release whose packages are already published: tag and bump, never
                     publish. For a run that died after \`npm publish\` and before the tag
  --registry <url>   check this registry instead of ${NPMJS_REGISTRY}
  --root <dir>       the checkout to release (default: this one)
  --result <file>    write the outcome as JSON, for the workflow's bump jobs to read

A push to main that carries no changesets re-runs this against a version the registry already
has in full; it exits 0 having published, tagged and opened nothing — unless the tag is missing,
which is what a stranded release looks like, and then it finishes that release.

The tag is pushed before the registry is verified, and \`--result\` is written even when the
verification fails: on 0.1.9 a 404 that outlived the propagation window threw away the tag and
the bump for nine packages that were already on npm.`;

export class ReleaseError extends Error {}

export type ReleaseCIOptions = {
  readonly root: string;
  readonly registry: string;
  readonly dryRun: boolean;
  /** Finish an already-published version: tag and bump without publishing. */
  readonly recover: boolean;
};

export type ReleaseCIDeps = {
  readonly exec: Exec;
  readonly registry: PackumentRegistryClient;
  readonly integrity: (tarball: string) => Promise<string>;
  readonly log: (line: string) => void;
  readonly wait?: PropagationWait;
};

export type ReleaseCIResult = {
  readonly version: string;
  readonly published: readonly string[];
  readonly skipped: readonly string[];
  readonly tagged: string | undefined;
  /**
   * Whether the workflow should now run the per-repo bump jobs: this run released the version,
   * and the registry serves it to installers.
   */
  readonly bumpable: boolean;
  /**
   * Why the registry does not yet agree with what was published here. Non-empty makes the run
   * fail, but only after the tag is pushed and this result is written: the packages are public
   * from the moment `npm publish` returns, so losing the record of them helps nobody.
   */
  readonly problems: readonly string[];
};

/** The one place a failure message is built, so `redact` is the one place it is cleaned. */
export function must(exec: Exec, cwd: string, command: string, args: readonly string[]): void {
  if (exec(command, args, { cwd }).status !== 0) {
    throw new ReleaseError(redact(`${command} ${args.join(" ")} failed in ${cwd}`));
  }
}

export function capture(
  exec: Exec,
  cwd: string,
  command: string,
  args: readonly string[],
): string {
  const result = exec(command, args, { cwd, capture: true });
  if (result.status !== 0) {
    throw new ReleaseError(redact(`${command} ${args.join(" ")} failed in ${cwd}`));
  }
  return result.stdout;
}

/** Absent file means no downstream; `parseDownstream` is the same reader CI builds its matrix from. */
export async function readDownstream(root: string): Promise<string[]> {
  const file = join(root, "downstream.txt");
  if (!existsSync(file)) return [];
  return parseDownstream(await readFile(file, "utf8"));
}

/**
 * Pushes `v<version>` unless it is already there, and reports whether this call created it.
 * `fetch-depth: 0` brings the tags, so the local ref is the answer for the remote too.
 */
function ensureTag(deps: ReleaseCIDeps, root: string, version: string): string | undefined {
  const tag = `v${version}`;
  const exists =
    deps.exec("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], {
      cwd: root,
      capture: true,
    }).status === 0;
  if (exists) {
    deps.log(`tag       ${tag} already exists`);
    return undefined;
  }
  must(deps.exec, root, "git", ["tag", tag]);
  must(deps.exec, root, "git", ["push", "origin", tag]);
  deps.log(`tag       ${tag} pushed`);
  return tag;
}

/** Why a bump PR opened now would pin a mixed `@hyperfixation/*` set, or nothing when it would not. */
async function installableProblems(
  deps: ReleaseCIDeps,
  order: readonly string[],
  version: string,
): Promise<string[]> {
  const { misses, waitedMs } = await awaitInstallable(
    deps.registry,
    order,
    version,
    deps.wait ?? {},
  );
  if (misses.length === 0) {
    deps.log(`\nAll ${order.length} abbreviated packuments serve ${version}.`);
    return [];
  }
  return misses.map(
    (miss) => `${miss.reason} (after ${Math.round(waitedMs / 1000)}s)`,
  );
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
  //
  // Unless there is no tag. A release that published all nine and then died leaves exactly this
  // state, and the missing `v<version>` is the difference between "nothing to do" and "finish
  // it" — so the next push to main recovers a stranded release on its own. `--recover` says the
  // same thing explicitly, for when the tag has already been restored by hand.
  if (already.size === order.length) {
    if (options.dryRun) {
      deps.log(`${version} is already on ${deps.registry.url} in full — nothing to do.`);
      return { version, published: [], skipped: order, tagged: undefined, bumpable: false, problems: [] };
    }
    const tagged = ensureTag(deps, options.root, version);
    if (tagged === undefined && !options.recover) {
      deps.log(`${version} is already on ${deps.registry.url} in full — nothing to do.`);
      return { version, published: [], skipped: order, tagged: undefined, bumpable: false, problems: [] };
    }
    deps.log(`${version} is already on ${deps.registry.url} in full — finishing the release.`);
    const downstream = await readDownstream(options.root);
    const problems =
      downstream.length > 0 ? await installableProblems(deps, order, version) : [];
    return {
      version,
      published: [],
      skipped: order,
      tagged,
      bumpable: downstream.length > 0 && problems.length === 0,
      problems,
    };
  }

  // Past here a tarball gets built and uploaded, which `--recover` promises it will never do. A
  // half-published version is not the stranded case; an ordinary re-run finishes it, skipping
  // whatever is already up.
  if (options.recover) {
    throw new ReleaseError(
      `${version} is not fully published — ${order.length - already.size} of ${order.length} ` +
        `packages are missing from ${deps.registry.url}.\n` +
        "--recover only finishes a release that is already on the registry; re-run the release " +
        "itself to publish the rest.",
    );
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
      return { version, published, skipped, tagged: undefined, bumpable: false, problems: [] };
    }

    // Before the verification, not after it. Everything above this line is already public and
    // cannot be taken back, so the tag is a record of what happened rather than a reward for the
    // registry answering promptly — which on 0.1.9 it did not.
    const tagged = ensureTag(deps, options.root, version);

    const problems = await registryProblems(
      deps.registry,
      version,
      tarballs,
      deps.integrity,
      deps.wait ?? {},
    );
    if (problems.length === 0) {
      deps.log(`\nAll ${tarballs.size} version documents match the tarballs packed from this commit.`);
    }

    // Skipped when the documents already disagree: there is nothing a second long wait can tell
    // us, and the bump is off either way.
    const downstream = await readDownstream(options.root);
    if (downstream.length > 0 && problems.length === 0) {
      problems.push(...(await installableProblems(deps, order, version)));
    }

    return {
      version,
      published,
      skipped,
      tagged,
      bumpable: downstream.length > 0 && problems.length === 0,
      problems,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      recover: { type: "boolean", default: false },
      registry: { type: "string", default: NPMJS_REGISTRY },
      root: { type: "string", default: CORE_ROOT },
      result: { type: "string" },
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
    recover: values.recover,
  };
  try {
    const result = await releaseCI(options, {
      exec: spawnExec,
      registry: httpRegistryClient(options.registry),
      integrity: tarballIntegrity,
      log: (line) => console.log(line),
    });
    // Written before the exit code is decided: the workflow's bump decision reads this file even
    // when the verification below fails, which is what keeps a slow registry from stranding a
    // release that is already on npm.
    if (values.result !== undefined) {
      await writeFile(resolve(values.result), JSON.stringify(result), "utf8");
    }
    console.log(
      `\n${result.version}: published ${result.published.length}, skipped ${result.skipped.length}` +
        `, tag ${result.tagged ?? "(unchanged)"}, bump ${result.bumpable}`,
    );
    if (result.problems.length > 0) {
      console.error(
        redact(
          `\nPublished ${result.tagged === undefined ? "" : `and tagged ${result.tagged} `}` +
            `— but the registry does not agree:\n  ${result.problems.join("\n  ")}\n` +
            "Nothing was left half-published; re-run this workflow once npmjs has caught up.",
        ),
      );
      return 1;
    }
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
