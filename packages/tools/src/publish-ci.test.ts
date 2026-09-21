import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseCI, type ReleaseCIDeps, type ReleaseCIOptions } from "./publish-ci.js";
import {
  NPMJS_REGISTRY,
  PROPAGATION_WINDOW_MS,
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
  /** How many polls the per-version document 404s for after the publish, per package name. */
  readonly documentLag: Map<string, number>;
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
  const documentLag = new Map<string, number>();
  const sleeps: number[] = [];
  const polls = new Map<string, number>();
  const documentPolls = new Map<string, number>();

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
    // The per-version document lags too, which is the 0.1.9 failure: `npm publish` had returned
    // for all nine and `@hyperfixation/admin` still 404ed.
    versionDocument: async (name) => {
      const document = documents.get(name);
      if (document === undefined) return { status: 404 };
      const seen = (documentPolls.get(name) ?? 0) + 1;
      documentPolls.set(name, seen);
      return seen <= (documentLag.get(name) ?? 0) ? { status: 404 } : document;
    },
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
    documentLag,
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
  return { root, registry: NPMJS_REGISTRY, dryRun: false, recover: false, ...overrides };
}

function tagCalls(calls: readonly Call[]): Call[] {
  return calls.filter((call) => call.command === "git" && call.args[0] === "tag");
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

  // The no-changesets push to main: this is the whole adversary target (a). The tag is what
  // tells it apart from the stranded release below, so reading the tag is the one thing it does.
  it("does nothing when every version is already on the registry and tagged", async () => {
    const harness = fake({ published: GROUP, tagExists: true });
    await withDownstream([TEMPLATE]);

    const result = await releaseCI(options(), harness.deps);

    expect(result).toEqual({
      version: "1.0.0",
      published: [],
      skipped: ["@hyperfixation/db", "@hyperfixation/core", "@hyperfixation/cli"],
      tagged: undefined,
      bumpable: false,
      problems: [],
    });
    expect(publishCalls(harness.calls)).toEqual([]);
    expect(tagCalls(harness.calls)).toEqual([]);
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

  it("reports a registry whose integrity differs, and opens no bump", async () => {
    const harness = fake({ integrity: async () => "sha512-something-else" });
    await withDownstream([TEMPLATE]);

    const result = await releaseCI(options(), harness.deps);

    expect(result.problems).toHaveLength(GROUP.length);
    expect(result.problems[0]).toMatch(/integrity is/u);
    expect(result.bumpable).toBe(false);
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

    const result = await releaseCI(options(), harness.deps);

    expect(result.problems).toEqual([
      expect.stringMatching(/@hyperfixation\/cli packument does not list 1\.0\.0/u),
    ]);
    expect(result.bumpable).toBe(false);
    // Published and recorded all the same: a bump PR is the only thing withheld.
    expect(result.tagged).toBe("v1.0.0");
  });

  // `downstream.txt` is read here only to decide whether the workflow runs its bump matrix at
  // all; nothing in this process ever holds a downstream repo's token.
  it("is not bumpable without downstream repos", async () => {
    const harness = fake({});

    const result = await releaseCI(options(), harness.deps);

    expect(result.bumpable).toBe(false);
  });

  // The 0.1.9 release. `@hyperfixation/admin` was on npm — `npm publish` had printed it with
  // provenance — and its version document 404ed for the whole 180s window, which threw before
  // the tag and took the tag, the result file and three bump PRs down with it.
  describe("a version document that lags the publish", () => {
    it("waits it out and releases normally", async () => {
      const harness = fake({});
      await withDownstream([TEMPLATE]);
      harness.documentLag.set("@hyperfixation/cli", 4);

      const result = await releaseCI(options(), harness.deps);

      expect(result.problems).toEqual([]);
      expect(result.tagged).toBe("v1.0.0");
      expect(result.bumpable).toBe(true);
      expect(harness.sleeps.slice(0, 4)).toEqual([2_000, 4_000, 8_000, 16_000]);
    });

    it("still tags what it published when the document never arrives", async () => {
      const harness = fake({});
      await withDownstream([TEMPLATE]);
      harness.documentLag.set("@hyperfixation/cli", NEVER);

      const result = await releaseCI(options(), harness.deps);

      // The run fails — but on the artefacts that matter it is indistinguishable from a success.
      expect(result.problems).toEqual([
        expect.stringMatching(/@hyperfixation\/cli@1\.0\.0 is not on/u),
      ]);
      expect(result.published).toHaveLength(GROUP.length);
      expect(result.tagged).toBe("v1.0.0");
      expect(tagCalls(harness.calls)).toHaveLength(1);
      expect(
        harness.calls.some((call) => call.command === "git" && call.args[0] === "push"),
      ).toBe(true);
    });

    it("waits far longer than the 180s the release lost", () => {
      expect(PROPAGATION_WINDOW_MS).toBeGreaterThanOrEqual(900_000);
    });
  });

  // Recovering that release: everything is on npm, so the re-run must finish it rather than
  // either republish or shrug. Without this the second release run said "nothing to do".
  describe("a stranded release", () => {
    it("tags and bumps an already-published version, publishing nothing", async () => {
      const harness = fake({ published: GROUP });
      await withDownstream([TEMPLATE]);

      const result = await releaseCI(options(), harness.deps);

      expect(published(harness.calls)).toEqual([]);
      expect(result.tagged).toBe("v1.0.0");
      expect(result.bumpable).toBe(true);
      expect(result.problems).toEqual([]);
    });

    it("bumps on --recover even once the tag has been restored by hand", async () => {
      const harness = fake({ published: GROUP, tagExists: true });
      await withDownstream([TEMPLATE]);

      const result = await releaseCI(options({ recover: true }), harness.deps);

      expect(published(harness.calls)).toEqual([]);
      expect(tagCalls(harness.calls)).toEqual([]);
      expect(result.tagged).toBeUndefined();
      expect(result.bumpable).toBe(true);
    });

    it("refuses --recover for a half-published version rather than publishing the rest", async () => {
      const harness = fake({ published: ["@hyperfixation/db"] });
      await withDownstream([TEMPLATE]);

      await expect(releaseCI(options({ recover: true }), harness.deps)).rejects.toThrow(
        /is not fully published/u,
      );
      expect(published(harness.calls)).toEqual([]);
    });

    it("withholds the bump when the packument does not yet serve the version", async () => {
      const harness = fake({ published: GROUP });
      await withDownstream([TEMPLATE]);
      harness.packumentLag.set("@hyperfixation/cli", NEVER);

      const result = await releaseCI(options({ recover: true }), harness.deps);

      expect(result.bumpable).toBe(false);
      expect(result.problems).toHaveLength(1);
    });
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
