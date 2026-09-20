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
  type RegistryClient,
} from "./registry.js";

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const USAGE = `Usage: pnpm release:verify <version> [--registry <url>] [--root <dir>]

The two checks a release needs whoever does the publishing: this checkout's fixed group is at
<version> with no workspace: ranges surviving \`pnpm pack\`, and every package's version document
on the registry exists with a dist.integrity matching the local tarball. This is what survives
the cutover to the OIDC workflow — see the README.`;

export type VerifyOptions = {
  readonly version: string;
  readonly root: string;
  readonly registry: string;
};

export type VerifyDeps = {
  readonly exec: Exec;
  readonly registry: RegistryClient;
  readonly integrity: (tarball: string) => Promise<string>;
};

/** Every problem found, not just the first: this is a diagnostic, not a gate on a publish. */
export async function verify(
  options: VerifyOptions,
  deps: VerifyDeps,
): Promise<string[]> {
  const group = await readFixedGroup(options.root);
  const manifests = await readGroupManifests(options.root, group);
  const problems = versionMismatches(manifests, options.version);

  const work = await mkdtemp(join(tmpdir(), "hf-verify-"));
  try {
    const tarballs = packPackages(deps.exec, options.root, group, work);
    problems.push(...workspaceRangeLeftovers(deps.exec, options.root, tarballs));
    problems.push(
      ...(await registryProblems(deps.registry, options.version, tarballs, deps.integrity)),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return problems;
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
  });
  if (problems.length === 0) {
    console.log(`\n${options.version} checks out locally and on ${options.registry}.`);
    return 0;
  }
  console.error(`\n${options.version}:\n  ${problems.join("\n  ")}`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
