import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  /** How many polls the abbreviated packument misses the version for, per package name. */
  readonly packumentLag: Map<string, number>;
  /** Every backoff the propagation waits slept, in order. */
  readonly sleeps: number[];
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
  integrity?: (tarball: string) => Promise<string>;
}): Fake {
  const calls: Call[] = [];
  const documents = new Map<string, VersionDocument>();
  const packedRanges = new Map<string, Record<string, string>>();
  const packumentLag = new Map<string, number>();
  const sleeps: number[] = [];
  const polls = new Map<string, number>();

  for (const name of options.published ?? []) {
    documents.set(name, { status: 200, integrity: `sha512-${name}` });
  }

  const exec: Exec = (command, args) => {
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

  return {
    calls,
    packedRanges,
    packumentLag,
    sleeps,
    deps: {
      exec,
      registry,
      integrity: options.integrity ?? (async (tarball) => `sha512-@hyperfixation/${nameOf(tarball)}`),
      log: () => {},
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
    const harness = fake({ published: GROUP });
    await withDownstream([TEMPLATE]);

    const result = await releaseCI(options(), harness.deps);

    expect(result).toEqual({
      version: "1.0.0",
      published: [],
      skipped: ["@hyperfixation/db", "@hyperfixation/core", "@hyperfixation/cli"],
      tagged: undefined,
      bumpable: false,
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

  // The 0.1.8 release: the per-version documents were all 200 while the packument for the three
  // packages published last still served 0.1.7, and the template's bump PR pinned a mixed set.
  it("waits for the abbreviated packument to serve the version before releasing the bumps", async () => {
    const harness = fake({});
    await withDownstream([TEMPLATE]);
    harness.packumentLag.set("@hyperfixation/cli", 3);

    const result = await releaseCI(options(), harness.deps);

    expect(result.bumpable).toBe(true);
    expect(harness.sleeps).toEqual([2_000, 4_000, 8_000]);
  });

  it("releases no bump job when a packument never serves the version", async () => {
    const harness = fake({});
    await withDownstream([TEMPLATE]);
    harness.packumentLag.set("@hyperfixation/cli", NEVER);

    await expect(releaseCI(options(), harness.deps)).rejects.toThrow(
      /@hyperfixation\/cli packument does not list 1\.0\.0/u,
    );
  });

  // `downstream.txt` is read here only to decide whether the workflow runs its bump matrix at
  // all; nothing in this process ever holds a downstream repo's token.
  it("is not bumpable without downstream repos", async () => {
    const harness = fake({});

    const result = await releaseCI(options(), harness.deps);

    expect(result.bumpable).toBe(false);
  });

  it("does nothing external in a dry run", async () => {
    const harness = fake({});
    await withDownstream([TEMPLATE]);

    const result = await releaseCI(options({ dryRun: true }), harness.deps);

    expect(result.published).toHaveLength(GROUP.length);
    expect(result.tagged).toBeUndefined();
    expect(result.bumpable).toBe(false);
    expect(publishCalls(harness.calls).every((call) => call.args.includes("--dry-run"))).toBe(true);
    expect(harness.calls.filter((call) => call.command === "git")).toEqual([]);
  });
});
