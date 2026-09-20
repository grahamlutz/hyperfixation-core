import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseCI, type ReleaseCIDeps, type ReleaseCIOptions } from "./publish-ci.js";
import {
  NPMJS_REGISTRY,
  type Exec,
  type PackumentRegistryClient,
  type VersionDocument,
} from "./registry.js";

const GROUP = ["@hyperfixation/db", "@hyperfixation/core", "@hyperfixation/cli"];
const VERSION = "1.0.0";
/** More polls than the propagation window allows: the packument never arrives. */
const NEVER = Number.MAX_SAFE_INTEGER;

/** Mirrors the real dependency direction: db ← core ← cli. */
const MANIFESTS: Record<string, Record<string, string>> = {
  "@hyperfixation/db": {},
  "@hyperfixation/core": { "@hyperfixation/db": "workspace:*" },
  "@hyperfixation/cli": { "@hyperfixation/core": "workspace:*" },
};

const TEMPLATE = "grahamlutz/hyperfixation-template";

type Call = { command: string; args: readonly string[] };

type Fake = {
  readonly calls: Call[];
  readonly deps: ReleaseCIDeps;
  /** `workspace:` ranges the packed manifests keep, per package name. */
  readonly packedRanges: Map<string, Record<string, string>>;
  /** Branches `git ls-remote --heads` reports, per downstream repo. */
  readonly remoteBranches: Map<string, string[]>;
  /** PR numbers `gh pr list --head` reports, per downstream repo. */
  readonly openPrs: Map<string, number[]>;
  /** How many polls the abbreviated packument misses the version for, per package name. */
  readonly packumentLag: Map<string, number>;
  /** Packages the clone's `pnpm update` leaves at their old version, per downstream repo. */
  readonly staleAfterUpdate: Map<string, string[]>;
  /** Every backoff the propagation waits slept, in order. */
  readonly sleeps: number[];
  /** `@hyperfixation/*` specs the cloned app's package.json carries. */
  appDependencies: Record<string, string>;
  /** Whether the pinned `pnpm update` leaves the clone dirty. */
  updateChanges: boolean;
};

let root: string;
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "hf-release-ci-test-"));
  root = join(scratch, "core");
  await writeCheckout(root, Object.fromEntries(GROUP.map((name) => [name, "1.0.0"])));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function writeCheckout(dir: string, versions: Record<string, string>): Promise<void> {
  await mkdir(join(dir, ".changeset"), { recursive: true });
  await writeFile(join(dir, ".changeset/config.json"), JSON.stringify({ fixed: [GROUP] }));
  for (const name of GROUP) {
    const packageDir = join(dir, "packages", name.replace("@hyperfixation/", ""));
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name, version: versions[name], dependencies: MANIFESTS[name] }),
    );
  }
}

function fake(options: {
  published?: readonly string[];
  tagExists?: boolean;
  downstream?: readonly string[];
  token?: string;
  integrity?: (tarball: string) => Promise<string>;
}): Fake {
  const calls: Call[] = [];
  const documents = new Map<string, VersionDocument>();
  const packedRanges = new Map<string, Record<string, string>>();
  const remoteBranches = new Map<string, string[]>();
  const openPrs = new Map<string, number[]>();
  const packumentLag = new Map<string, number>();
  const staleAfterUpdate = new Map<string, string[]>();
  const sleeps: number[] = [];
  const polls = new Map<string, number>();
  /** Which downstream repo each clone directory holds, so `pnpm update` knows whose app it is. */
  const clones = new Map<string, string>();
  const state = {
    appDependencies: Object.fromEntries(GROUP.map((name) => [name, "^0.9.0"])),
    updateChanges: true,
  };

  for (const name of options.published ?? []) {
    documents.set(name, { status: 200, integrity: `sha512-${name}` });
  }

  const exec: Exec = (command, args, execOptions) => {
    calls.push({ command, args });
    const joined = args.join(" ");
    if (command === "tar") {
      const name = GROUP.find((candidate) =>
        args[1].includes(candidate.replace("@hyperfixation/", "hyperfixation-")),
      );
      return {
        status: 0,
        stdout: JSON.stringify({ name, dependencies: packedRanges.get(name ?? "") ?? {} }),
      };
    }
    if (command === "pnpm" && args.includes("pack")) {
      const destination = args[args.indexOf("--pack-destination") + 1];
      mkdirSync(destination, { recursive: true });
      const packed = GROUP.map((name) => ({
        name,
        filename: join(destination, `${name.replace("@hyperfixation/", "hyperfixation-")}-1.0.0.tgz`),
      }));
      for (const { filename } of packed) writeFileSync(filename, "tarball");
      return { status: 0, stdout: JSON.stringify(packed) };
    }
    if (command === "npm" && args[0] === "publish" && !args.includes("--dry-run")) {
      const name = `@hyperfixation/${nameOf(args[1])}`;
      documents.set(name, { status: 200, integrity: `sha512-${name}` });
      return { status: 0, stdout: "" };
    }
    if (command === "git" && joined.startsWith("rev-parse")) {
      return { status: options.tagExists === true ? 0 : 1, stdout: "" };
    }
    if (command === "git" && args[0] === "ls-remote") {
      const repo = repoOf(args[2]);
      const branch = args[3].replace("refs/heads/", "");
      const has = (remoteBranches.get(repo) ?? []).includes(branch);
      return { status: 0, stdout: has ? `abc123\trefs/heads/${branch}\n` : "" };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      const repo = args[args.indexOf("--repo") + 1];
      return {
        status: 0,
        stdout: JSON.stringify((openPrs.get(repo) ?? []).map((number) => ({ number }))),
      };
    }
    if (command === "git" && args[0] === "clone") {
      const destination = args[args.length - 1];
      clones.set(destination, repoOf(args[args.length - 2]));
      mkdirSync(destination, { recursive: true });
      writeFileSync(
        join(destination, "package.json"),
        JSON.stringify({ name: "app", dependencies: state.appDependencies }),
      );
      return { status: 0, stdout: "" };
    }
    // A real `pnpm update` rewrites both files; the stale names are the 0.1.8 failure.
    if (command === "pnpm" && args[0] === "update") {
      const stale = staleAfterUpdate.get(clones.get(execOptions.cwd) ?? "") ?? [];
      const specs = Object.fromEntries(
        Object.keys(state.appDependencies).map((name) => [
          name,
          stale.includes(name) ? "^0.9.0" : `^${VERSION}`,
        ]),
      );
      writeFileSync(
        join(execOptions.cwd, "package.json"),
        JSON.stringify({ name: "app", dependencies: specs }),
      );
      writeFileSync(
        join(execOptions.cwd, "pnpm-lock.yaml"),
        Object.entries(specs)
          .map(([name, spec]) => `  '${name}@${spec.slice(1)}': {}`)
          .join("\n"),
      );
      return { status: 0, stdout: "" };
    }
    if (command === "git" && joined === "status --porcelain") {
      return { status: 0, stdout: state.updateChanges ? " M package.json\n" : "" };
    }
    return { status: 0, stdout: "" };
  };

  const registry: PackumentRegistryClient = {
    url: NPMJS_REGISTRY,
    versionDocument: async (name) => documents.get(name) ?? { status: 404 },
    // The packument lags the per-version document: as npmjs does, it answers 200 with the
    // release before until this package's polls run out.
    abbreviatedPackument: async (name) => {
      if (!documents.has(name)) return { status: 404 };
      const seen = (polls.get(name) ?? 0) + 1;
      polls.set(name, seen);
      if (seen <= (packumentLag.get(name) ?? 0)) {
        return { status: 200, versions: ["0.9.0"], latest: "0.9.0" };
      }
      return { status: 200, versions: ["0.9.0", VERSION], latest: VERSION };
    },
  };

  for (const repo of options.downstream ?? []) remoteBranches.set(repo, []);

  return {
    calls,
    packedRanges,
    remoteBranches,
    openPrs,
    packumentLag,
    staleAfterUpdate,
    sleeps,
    get appDependencies() {
      return state.appDependencies;
    },
    set appDependencies(value: Record<string, string>) {
      state.appDependencies = value;
    },
    get updateChanges() {
      return state.updateChanges;
    },
    set updateChanges(value: boolean) {
      state.updateChanges = value;
    },
    deps: {
      exec,
      registry,
      integrity: options.integrity ?? (async (tarball) => `sha512-@hyperfixation/${nameOf(tarball)}`),
      log: () => {},
      token: options.token ?? "bot-token",
      wait: {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    },
  };
}

function nameOf(tarball: string): string {
  return /hyperfixation-(?<name>[a-z-]+)-1\.0\.0\.tgz$/u.exec(tarball)?.groups?.name ?? "?";
}

function repoOf(url: string): string {
  return /github\.com\/(?<repo>[^/]+\/[^/]+)\.git$/u.exec(url)?.groups?.repo ?? "?";
}

function publishCalls(calls: readonly Call[]): Call[] {
  return calls.filter((call) => call.command === "npm" && call.args[0] === "publish");
}

function published(calls: readonly Call[]): string[] {
  return publishCalls(calls).map((call) => `@hyperfixation/${nameOf(call.args[1])}`);
}

async function withDownstream(repos: readonly string[]): Promise<void> {
  await writeFile(join(root, "downstream.txt"), `# a comment\n\n${repos.join("\n")}\n`);
}

function options(overrides: Partial<ReleaseCIOptions> = {}): ReleaseCIOptions {
  return { root, registry: NPMJS_REGISTRY, dryRun: false, ...overrides };
}

describe("releaseCI", () => {
  it("publishes the group in dependency order with provenance", async () => {
    const harness = fake({});

    const result = await releaseCI(options(), harness.deps);

    expect(result.published).toEqual([
      "@hyperfixation/db",
      "@hyperfixation/core",
      "@hyperfixation/cli",
    ]);
    expect(published(harness.calls)).toEqual(result.published);
    expect(
      publishCalls(harness.calls).every(
        (call) => call.args.includes("--provenance") && call.args.includes("--access"),
      ),
    ).toBe(true);
    expect(result.tagged).toBe("v1.0.0");
  });

  it("skips a package the registry already has and publishes the rest", async () => {
    const harness = fake({ published: ["@hyperfixation/db"] });

    const result = await releaseCI(options(), harness.deps);

    expect(result.skipped).toEqual(["@hyperfixation/db"]);
    expect(published(harness.calls)).toEqual(["@hyperfixation/core", "@hyperfixation/cli"]);
  });

  // The no-changesets push to main: this is the whole adversary target (a).
  it("does nothing when every version is already on the registry", async () => {
    const harness = fake({ published: GROUP, downstream: [TEMPLATE] });
    await withDownstream([TEMPLATE]);

    const result = await releaseCI(options(), harness.deps);

    expect(result).toEqual({
      version: "1.0.0",
      published: [],
      skipped: ["@hyperfixation/db", "@hyperfixation/core", "@hyperfixation/cli"],
      tagged: undefined,
      bumped: [],
      untouched: [],
    });
    expect(harness.calls).toEqual([]);
  });

  it("refuses to publish when a packed manifest still carries a workspace: range", async () => {
    const harness = fake({});
    harness.packedRanges.set("@hyperfixation/core", { "@hyperfixation/db": "workspace:*" });

    await expect(releaseCI(options(), harness.deps)).rejects.toThrow(/still workspace:\*/u);
    expect(published(harness.calls)).toEqual([]);
  });

  it("stops when the fixed group does not agree on a version", async () => {
    const harness = fake({});
    await writeCheckout(root, {
      "@hyperfixation/db": "1.0.0",
      "@hyperfixation/core": "0.9.9",
      "@hyperfixation/cli": "1.0.0",
    });

    await expect(releaseCI(options(), harness.deps)).rejects.toThrow(/does not agree/u);
  });

  it("fails the verification when the registry's integrity differs", async () => {
    const harness = fake({ integrity: async () => "sha512-something-else" });

    await expect(releaseCI(options(), harness.deps)).rejects.toThrow(/integrity is/u);
  });

  it("leaves an existing tag alone", async () => {
    const harness = fake({ tagExists: true });

    const result = await releaseCI(options(), harness.deps);

    expect(result.tagged).toBeUndefined();
    expect(harness.calls.some((call) => call.command === "git" && call.args[0] === "tag")).toBe(false);
  });

  it("opens one bump PR per downstream line", async () => {
    const other = "grahamlutz/demo-app";
    const harness = fake({ downstream: [TEMPLATE, other] });
    await withDownstream([TEMPLATE, other]);

    const result = await releaseCI(options(), harness.deps);

    expect(result.bumped).toEqual([TEMPLATE, other]);
    const created = harness.calls.filter(
      (call) => call.command === "gh" && call.args[1] === "create",
    );
    expect(created).toHaveLength(2);
    expect(created[0].args).toContain("core-bump/1.0.0");
    expect(created[0].args).toContain("Bump @hyperfixation/* to 1.0.0");
  });

  // `--latest` resolves whatever the packument names, so it can silently pin the release before.
  it("pins the update to the exact version", async () => {
    const harness = fake({ downstream: [TEMPLATE] });
    await withDownstream([TEMPLATE]);

    await releaseCI(options(), harness.deps);

    const updates = harness.calls.filter(
      (call) => call.command === "pnpm" && call.args[0] === "update",
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].args).toEqual(["update", "@hyperfixation/*@1.0.0"]);
  });

  // The 0.1.8 release: the per-version documents were all 200 while the packument for the three
  // packages published last still served 0.1.7, and the template's bump PR pinned a mixed set.
  it("waits for the abbreviated packument to serve the version before bumping", async () => {
    const harness = fake({ downstream: [TEMPLATE] });
    await withDownstream([TEMPLATE]);
    harness.packumentLag.set("@hyperfixation/cli", 3);

    const result = await releaseCI(options(), harness.deps);

    expect(result.bumped).toEqual([TEMPLATE]);
    expect(harness.sleeps).toEqual([2_000, 4_000, 8_000]);
    expect(
      harness.calls.filter((call) => call.command === "gh" && call.args[1] === "create"),
    ).toHaveLength(1);
  });

  it("opens no bump PR when a packument never serves the version", async () => {
    const harness = fake({ downstream: [TEMPLATE] });
    await withDownstream([TEMPLATE]);
    harness.packumentLag.set("@hyperfixation/cli", NEVER);

    await expect(releaseCI(options(), harness.deps)).rejects.toThrow(
      /@hyperfixation\/cli packument does not list 1\.0\.0/u,
    );
    expect(harness.calls.some((call) => call.command === "git" && call.args[0] === "clone")).toBe(
      false,
    );
  });

  it("refuses the one repo the update left behind and bumps the others", async () => {
    const other = "grahamlutz/demo-app";
    const harness = fake({ downstream: [TEMPLATE, other] });
    await withDownstream([TEMPLATE, other]);
    harness.staleAfterUpdate.set(TEMPLATE, ["@hyperfixation/cli"]);

    await expect(releaseCI(options(), harness.deps)).rejects.toThrow(
      /hyperfixation-template is not wholly on 1\.0\.0/u,
    );
    const created = harness.calls.filter(
      (call) => call.command === "gh" && call.args[1] === "create",
    );
    expect(created).toHaveLength(1);
    expect(created[0].args).toContain(other);
  });

  it("opens no bump PR when the branch is already there", async () => {
    const harness = fake({ downstream: [TEMPLATE] });
    await withDownstream([TEMPLATE]);
    harness.remoteBranches.set(TEMPLATE, ["core-bump/1.0.0"]);

    const result = await releaseCI(options(), harness.deps);

    expect(result.bumped).toEqual([]);
    expect(result.untouched).toEqual([TEMPLATE]);
    expect(harness.calls.some((call) => call.command === "git" && call.args[0] === "clone")).toBe(false);
  });

  // A merged bump PR's branch is deleted, so the branch check alone would reopen it.
  it("opens no bump PR when a PR for that version already existed", async () => {
    const harness = fake({ downstream: [TEMPLATE] });
    await withDownstream([TEMPLATE]);
    harness.openPrs.set(TEMPLATE, [12]);

    const result = await releaseCI(options(), harness.deps);

    expect(result.untouched).toEqual([TEMPLATE]);
    expect(harness.calls.some((call) => call.command === "git" && call.args[0] === "clone")).toBe(false);
  });

  it("commits nothing when the downstream repo is already at the version", async () => {
    const harness = fake({ downstream: [TEMPLATE] });
    await withDownstream([TEMPLATE]);
    harness.updateChanges = false;

    const result = await releaseCI(options(), harness.deps);

    expect(result.untouched).toEqual([TEMPLATE]);
    expect(harness.calls.some((call) => call.command === "gh" && call.args[1] === "create")).toBe(false);
  });

  it("refuses to start the bumps without a bot token", async () => {
    const harness = fake({ downstream: [TEMPLATE], token: "" });
    await withDownstream([TEMPLATE]);

    await expect(releaseCI(options(), harness.deps)).rejects.toThrow(/hyperfixation-bot/u);
  });

  it("does nothing external in a dry run", async () => {
    const harness = fake({ downstream: [TEMPLATE] });
    await withDownstream([TEMPLATE]);

    const result = await releaseCI(options({ dryRun: true }), harness.deps);

    expect(result.published).toHaveLength(GROUP.length);
    expect(result.tagged).toBeUndefined();
    expect(result.bumped).toEqual([]);
    expect(publishCalls(harness.calls).every((call) => call.args.includes("--dry-run"))).toBe(true);
    expect(harness.calls.filter((call) => call.command === "gh")).toEqual([]);
    expect(harness.calls.filter((call) => call.command === "git")).toEqual([]);
  });
});
