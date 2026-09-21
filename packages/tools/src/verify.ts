import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  httpAttestationFetcher,
  npmSignatureAudit,
  provenanceProblems,
  readProvenance,
  type AttestationFetcher,
  type SignatureAudit,
} from "./attestation.js";
import {
  compareTarballs,
  httpRegistryClient,
  integrityDifference,
  isLocalRegistry,
  missingProblem,
  NPMJS_REGISTRY,
  packPackages,
  readFixedGroup,
  readGroupManifests,
  spawnExec,
  tarballIntegrity,
  versionBumpCommit,
  versionMismatches,
  workspaceRangeLeftovers,
  type Exec,
  type PropagationWait,
  type RegistryClient,
} from "./registry.js";

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const USAGE = `Usage: pnpm release:verify <version> [--registry <url>] [--root <dir>] [--no-fetch]

The checks a release needs whoever did the publishing: the release commit's fixed group is at
<version> with no workspace: ranges surviving \`pnpm pack\`, every package's version document
exists on the registry, and the tarball it serves was built from that commit by this repo's
release workflow. For a version published by \`.github/workflows/release.yml\` that last part is
the provenance attestation — its subject digest must be the registry's dist.integrity and its
build must name grahamlutz/hyperfixation-core, .github/workflows/release.yml and the release
commit — plus \`npm audit signatures\`, which verifies the Sigstore bundle cryptographically.
A rebuild of the release commit in a throwaway worktree is still packed and compared, but for an
attested version a byte difference is reported as a warning: the attestation already pins the
tarball, and a rebuild only ever proved that this machine agreed with the publisher's.
For a version with no attestation (0.1.0, 0.1.1) that rebuild comparison is the only check there
is, and a difference fails. \`origin/main\` and the tags are fetched first, because the release
commit is resolved from them; --no-fetch verifies against the refs the checkout already has.
See the README.`;

export type VerifyOptions = {
  readonly version: string;
  readonly root: string;
  readonly registry: string;
  /** Refresh `origin/main` and the tags before resolving the release commit. Default: true. */
  readonly fetch?: boolean;
};

export type VerifyDeps = {
  readonly exec: Exec;
  readonly registry: RegistryClient;
  readonly integrity: (tarball: string) => Promise<string>;
  readonly log: (line: string) => void;
  readonly attestations: AttestationFetcher;
  readonly audit: SignatureAudit;
  readonly wait?: PropagationWait;
};

export type VerifyReport = {
  readonly problems: readonly string[];
  /** Differences something stronger has already accounted for; they do not fail the run. */
  readonly warnings: readonly string[];
};

export type ReleaseCommit = { readonly sha: string; readonly source: string };

function capture(exec: Exec, root: string, args: readonly string[]): string | undefined {
  const result = exec("git", args, { cwd: root, capture: true });
  const output = result.stdout.trim();
  return result.status === 0 && output !== "" ? output : undefined;
}

/**
 * Every ref the release commit is resolved from is local, so a checkout that has not fetched
 * since the publish resolves the wrong commit and then reports the whole group as mismatched.
 */
export function fetchReleaseRefs(exec: Exec, root: string): void {
  if (exec("git", ["fetch", "origin", "main", "--tags", "--quiet"], { cwd: root }).status !== 0) {
    throw new Error(
      `git fetch origin main --tags failed in ${root}. The release commit is resolved from origin/main and the tags, and a stale ref reports the wrong commit's tarballs as mismatched; fix the fetch, or pass --no-fetch to accept the refs this checkout already has.`,
    );
  }
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
  const bump = versionBumpCommit(exec, root, version);
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

/**
 * Every package's registry tarball tied back to the release commit: by its provenance attestation
 * where there is one, by the rebuild comparison where there is not.
 */
async function originProblems(
  options: VerifyOptions,
  deps: VerifyDeps,
  commit: ReleaseCommit,
  tarballs: ReadonlyMap<string, string>,
): Promise<VerifyReport> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const attested: string[] = [];

  for (const comparison of await compareTarballs(
    deps.registry,
    options.version,
    tarballs,
    deps.integrity,
    deps.wait ?? {},
  )) {
    const missing = missingProblem(deps.registry.url, options.version, comparison);
    if (missing !== undefined) {
      problems.push(missing);
      continue;
    }
    const difference = integrityDifference(options.version, comparison);
    const response = await deps.attestations(comparison.name, options.version);
    const provenance = response === undefined ? undefined : readProvenance(response);

    if (provenance === undefined) {
      // Pre-OIDC: nothing says where the tarball came from, so a rebuild that disagrees is all
      // the evidence there is and it has to count.
      if (difference !== undefined) {
        problems.push(`${difference} — and ${comparison.name}@${options.version} has no provenance attestation, so the rebuild is the only check (rebuilt from ${commit.sha}, ${commit.source})`);
      }
      continue;
    }

    attested.push(comparison.name);
    problems.push(
      ...provenanceProblems(
        {
          name: comparison.name,
          version: options.version,
          integrity: comparison.document.integrity,
          commit: commit.sha,
        },
        provenance,
      ),
    );
    if (difference !== undefined) {
      warnings.push(`${difference} — informational: the provenance attestation covers the registry's tarball, so this is a difference between the two builds, not a bad publish (rebuilt from ${commit.sha}, ${commit.source})`);
    }
    if (provenance.runUrl !== undefined) deps.log(`attested  ${comparison.name} ${provenance.runUrl}`);
  }

  // The payload checks above read an unverified envelope; this is what proves it was signed.
  if (attested.length > 0 && !isLocalRegistry(options.registry)) {
    problems.push(...(await deps.audit(attested, options.version)));
  }
  return { problems, warnings };
}

/** Every problem found, not just the first: this is a diagnostic, not a gate on a publish. */
export async function verify(
  options: VerifyOptions,
  deps: VerifyDeps,
): Promise<VerifyReport> {
  if (options.fetch !== false) fetchReleaseRefs(deps.exec, options.root);
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
        return {
          problems: [
            ...mismatches.map((problem) => `${problem} at ${commit.sha} (${commit.source})`),
            `Nothing was packed: ${commit.source} is not the ${options.version} release commit.`,
          ],
          warnings: [],
        };
      }

      must(deps.exec, checkout, "pnpm", ["install", "--frozen-lockfile"]);
      must(deps.exec, checkout, "pnpm", ["-r", "build"]);

      const tarballs = packPackages(deps.exec, checkout, group, tarballDir);
      const leftovers = workspaceRangeLeftovers(deps.exec, checkout, tarballs);
      const origin = await originProblems(options, deps, commit, tarballs);
      return { problems: [...leftovers, ...origin.problems], warnings: origin.warnings };
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
      "no-fetch": { type: "boolean", default: false },
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
    fetch: !values["no-fetch"],
  };
  const report = await verify(options, {
    exec: spawnExec,
    registry: httpRegistryClient(options.registry),
    integrity: tarballIntegrity,
    attestations: httpAttestationFetcher(options.registry),
    audit: npmSignatureAudit(spawnExec),
    log: (line) => console.log(line),
  });
  if (report.warnings.length > 0) {
    console.log(`\nwarnings:\n  ${report.warnings.join("\n  ")}`);
  }
  if (report.problems.length === 0) {
    console.log(`\n${options.version} checks out at the release commit and on ${options.registry}.`);
    return 0;
  }
  console.error(`\n${options.version}:\n  ${report.problems.join("\n  ")}`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
