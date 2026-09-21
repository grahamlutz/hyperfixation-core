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
  --registry <url>   check this registry instead of ${NPMJS_REGISTRY}
  --root <dir>       the checkout to release (default: this one)
  --result <file>    write the outcome as JSON, for the workflow's bump jobs to read

A push to main that carries no changesets re-runs this against a version the registry already
has in full; it exits 0 having published, tagged and opened nothing.`;

export class ReleaseError extends Error {}

export type ReleaseCIOptions = {
  readonly root: string;
  readonly registry: string;
  readonly dryRun: boolean;
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
   * Whether the workflow should now run the per-repo bump jobs: something was published, and the
   * registry serves it to installers.
   */
  readonly bumpable: boolean;
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
    return { version, published: [], skipped: order, tagged: undefined, bumpable: false };
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
      return { version, published, skipped, tagged: undefined, bumpable: false };
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
    if (downstream.length > 0) {
      const { misses, waitedMs } = await awaitInstallable(
        deps.registry,
        order,
        version,
        deps.wait ?? {},
      );
      if (misses.length > 0) {
        throw new ReleaseError(
          `The registry is still not serving ${version} to installers after ` +
            `${Math.round(waitedMs / 1000)}s:\n  ${misses.map((miss) => miss.reason).join("\n  ")}\n` +
            "A bump PR opened now would pin a mixed @hyperfixation/* set; re-run this job.",
        );
      }
      deps.log(`\nAll ${order.length} abbreviated packuments serve ${version}.`);
    }

    return {
      version,
      published,
      skipped,
      tagged: exists ? undefined : tag,
      bumpable: downstream.length > 0 && published.length > 0,
    };
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
  };
  try {
    const result = await releaseCI(options, {
      exec: spawnExec,
      registry: httpRegistryClient(options.registry),
      integrity: tarballIntegrity,
      log: (line) => console.log(line),
    });
    if (values.result !== undefined) {
      await writeFile(resolve(values.result), JSON.stringify(result), "utf8");
    }
    console.log(
      `\n${result.version}: published ${result.published.length}, skipped ${result.skipped.length}` +
        `, tag ${result.tagged ?? "(unchanged)"}, bump ${result.bumpable}`,
    );
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
