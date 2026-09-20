import { mkdtemp, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  dispatchCommand,
  httpRegistryClient,
  isLocalRegistry,
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
  type RegistryClient,
} from "./registry.js";

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const USAGE = `Usage: pnpm release:publish <version> [--registry <url>] [--dry-run] [--yes] [--keep]

Publishes the fixed group at <version> from a fresh clone of origin/main — never from this
working tree. Stores no token and writes no .npmrc: npm's own 2FA browser approval is the
credential, which is why the command refuses to run outside a terminal.

  --registry <url>   publish here instead of ${NPMJS_REGISTRY} (release:rehearse uses it)
  --dry-run          stop after \`pnpm -r publish --dry-run\`
  --yes              skip the typed confirmation; rejected against npmjs
  --keep             leave the clone and the tarballs in place for inspection

Re-running after a partial publish is the retry: a package whose version document is already
200 is skipped, and nothing is ever unpublished.`;

export class PublishError extends Error {}

export type PublishOptions = {
  readonly version: string;
  readonly registry: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly keep: boolean;
};

export type PublishDeps = {
  readonly exec: Exec;
  readonly registry: RegistryClient;
  /** Fills `destination` with a fresh checkout of origin/main. */
  readonly clone: (destination: string) => Promise<void>;
  readonly confirm: (question: string) => Promise<string>;
  readonly isTTY: boolean;
  readonly log: (line: string) => void;
  readonly integrity: (tarball: string) => Promise<string>;
};

export type PublishResult = {
  readonly published: readonly string[];
  readonly skipped: readonly string[];
  readonly tarballs: ReadonlyMap<string, string>;
};

export function gitCloneOriginMain(exec: Exec): (destination: string) => Promise<void> {
  return async (destination) => {
    const origin = exec("git", ["remote", "get-url", "origin"], {
      cwd: CORE_ROOT,
      capture: true,
    });
    if (origin.status !== 0) throw new PublishError("Could not read this checkout's origin URL");
    const url = origin.stdout.trim();
    const cloned = exec(
      "git",
      ["clone", "--depth", "1", "--branch", "main", url, destination],
      { cwd: tmpdir() },
    );
    if (cloned.status !== 0) throw new PublishError(`git clone of ${url} failed`);
  };
}

export function defaultPublishDeps(registryUrl: string): PublishDeps {
  return {
    exec: spawnExec,
    registry: httpRegistryClient(registryUrl),
    clone: gitCloneOriginMain(spawnExec),
    confirm: async (question) => {
      const io = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await io.question(question);
      } finally {
        io.close();
      }
    },
    isTTY: process.stdout.isTTY === true,
    log: (line) => console.log(line),
    integrity: tarballIntegrity,
  };
}

function must(exec: Exec, cwd: string, command: string, args: readonly string[]): void {
  if (exec(command, args, { cwd }).status !== 0) {
    throw new PublishError(`${command} ${args.join(" ")} failed`);
  }
}

/** The 2FA posture a real publish needs, checked before anything is uploaded. */
function assertNpmjsAuth(exec: Exec): void {
  const whoami = exec("npm", ["whoami"], { cwd: CORE_ROOT, capture: true });
  if (whoami.status !== 0) {
    throw new PublishError("`npm whoami` failed — log in with `npm login` first (no token is stored by this script).");
  }
  const profile = exec("npm", ["profile", "get", "--json"], { cwd: CORE_ROOT, capture: true });
  if (profile.status !== 0) throw new PublishError("`npm profile get --json` failed");
  const { tfa } = JSON.parse(profile.stdout) as { tfa?: string | { mode?: string } };
  const mode = typeof tfa === "string" ? tfa : tfa?.mode;
  if (mode !== "auth-and-writes") {
    throw new PublishError(
      `npm 2FA mode is ${mode ?? "(none)"}, not auth-and-writes. A publish without 2FA on writes ` +
        "returns 403 for these packages; set it at npmjs.com → Account → Two-factor authentication " +
        "(Authorization and writes) and re-run.",
    );
  }
}

export async function publish(
  options: PublishOptions,
  deps: PublishDeps,
): Promise<PublishResult> {
  // Anything that is not loopback is treated as the real thing: a rehearsal is the only case
  // that may skip the 2FA and confirmation guards.
  const real = !isLocalRegistry(options.registry);
  if (real) {
    if (!deps.isTTY) {
      throw new PublishError(
        "Refusing to publish to npmjs: stdout is not a TTY. npm's 2FA approval prints a URL and " +
          "waits on Enter, so the publish has to run in a visible terminal.",
      );
    }
    if (options.yes) {
      throw new PublishError("--yes is for rehearsals against a local registry; a real publish needs a typed yes.");
    }
  }

  const work = await mkdtemp(join(tmpdir(), "hf-release-"));
  const checkout = join(work, "core");
  const tarballDir = join(work, "tarballs");
  try {
    deps.log(`clone:    ${checkout}`);
    deps.log(`registry: ${options.registry}`);
    await deps.clone(checkout);

    const group = await readFixedGroup(checkout);
    const manifests = await readGroupManifests(checkout, group);
    const mismatches = versionMismatches(manifests, options.version);
    if (mismatches.length > 0) {
      throw new PublishError(
        `origin/main is not at ${options.version}:\n  ${mismatches.join("\n  ")}\n` +
          "Version and merge the changesets first — a release publishes what main says.",
      );
    }

    if (real) assertNpmjsAuth(deps.exec);

    // Install and build before packing: a fresh clone has no `node_modules`, and `pnpm pack`
    // needs the workspace resolved to rewrite `workspace:` ranges and `dist` to exist.
    must(deps.exec, checkout, "pnpm", ["install", "--frozen-lockfile"]);
    must(deps.exec, checkout, "pnpm", ["-r", "build"]);

    const tarballs = packPackages(deps.exec, checkout, group, tarballDir);
    const leftovers = workspaceRangeLeftovers(deps.exec, checkout, tarballs);
    if (leftovers.length > 0) {
      throw new PublishError(`Packed manifests still carry workspace: ranges:\n  ${leftovers.join("\n  ")}`);
    }

    const filters = group.flatMap((name) => ["--filter", name]);
    const registryArgs = options.registry === NPMJS_REGISTRY ? [] : ["--registry", options.registry];
    must(deps.exec, checkout, "pnpm", [
      "-r",
      ...filters,
      "publish",
      "--access",
      "public",
      "--dry-run",
      "--no-git-checks",
      ...registryArgs,
    ]);

    deps.log(`\n${tarballs.size} tarballs at ${options.version}:`);
    for (const [name, tarball] of tarballs) {
      const { size } = await stat(tarball);
      deps.log(`  ${basename(tarball).padEnd(44)} ${(size / 1024).toFixed(0)} KiB  (${name})`);
    }

    if (options.dryRun) {
      deps.log("\n--dry-run: stopping before the real publish.");
      return { published: [], skipped: [], tarballs };
    }

    if (!options.yes) {
      const answer = await deps.confirm(`\nPublish these to ${options.registry}? Type yes to continue: `);
      if (answer.trim() !== "yes") throw new PublishError("Not confirmed; nothing was published.");
    }

    const published: string[] = [];
    const skipped: string[] = [];
    for (const name of topologicalOrder(manifests)) {
      const existing = await deps.registry.versionDocument(name, options.version);
      if (existing.status === 200) {
        deps.log(`skip      ${name}@${options.version} is already published`);
        skipped.push(name);
        continue;
      }
      deps.log(`publish   ${name}@${options.version}`);
      must(deps.exec, checkout, "pnpm", [
        "--filter",
        name,
        "publish",
        "--access",
        "public",
        "--no-git-checks",
        ...registryArgs,
      ]);
      published.push(name);
    }

    const problems = await registryProblems(deps.registry, options.version, tarballs, deps.integrity);
    if (problems.length > 0) {
      throw new PublishError(`Published, but the registry does not agree:\n  ${problems.join("\n  ")}`);
    }
    deps.log(`\nAll ${tarballs.size} version documents are present and match the local tarballs.`);
    deps.log(`\nNow tell the template (not run for you):\n  ${dispatchCommand(options.version)}`);

    return { published, skipped, tarballs };
  } finally {
    if (options.keep) deps.log(`\nKept ${work}`);
    else await rm(work, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      registry: { type: "string", default: NPMJS_REGISTRY },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const options: PublishOptions = {
    version: positionals[0],
    registry: values.registry,
    dryRun: values["dry-run"],
    yes: values.yes,
    keep: values.keep,
  };
  try {
    const result = await publish(options, defaultPublishDeps(options.registry));
    console.log(
      `\npublished ${result.published.length}, skipped ${result.skipped.length} already at ${options.version}`,
    );
    return 0;
  } catch (error) {
    if (error instanceof PublishError) {
      console.error(`\n${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
