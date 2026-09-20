import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NPMJS_REGISTRY,
  PROPAGATION_WINDOW_MS,
  type Exec,
  type RegistryClient,
  type VersionDocument,
} from "./registry.js";
import { resolveReleaseCommit, verify, type VerifyDeps, type VerifyOptions } from "./verify.js";

const GROUP = ["@hyperfixation/db", "@hyperfixation/core", "@hyperfixation/cli"];
const VERSION = "1.0.0";
const RELEASE_SHA = "c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ffe";

type Call = { command: string; args: readonly string[]; cwd: string };

function writeCheckout(root: string, versions: Record<string, string>): void {
  mkdirSync(join(root, ".changeset"), { recursive: true });
  writeFileSync(join(root, ".changeset/config.json"), JSON.stringify({ fixed: [GROUP] }));
  for (const name of GROUP) {
    const dir = join(root, "packages", name.replace("@hyperfixation/", ""));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: versions[name] }));
  }
}

const sameVersion = (version: string): Record<string, string> =>
  Object.fromEntries(GROUP.map((name) => [name, version]));

const integrityOf = (name: string): string => `sha512-${name}`;

type Harness = {
  readonly calls: Call[];
  readonly deps: VerifyDeps;
  readonly slept: number[];
  /** Version documents answered per package, in order; the last one repeats. */
  readonly documents: Map<string, VersionDocument[]>;
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hf-verify-test-"));
  // The user's working tree: a feature branch at a version nobody is releasing.
  writeCheckout(root, sameVersion("9.9.9-feature"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fake(options: {
  /** What the release commit's worktree carries. */
  worktreeVersions?: Record<string, string>;
  documents?: Map<string, VersionDocument[]>;
  tagged?: boolean;
}): Harness {
  const calls: Call[] = [];
  const slept: number[] = [];
  const documents =
    options.documents ??
    new Map(GROUP.map((name) => [name, [{ status: 200, integrity: integrityOf(name) }]]));

  const exec: Exec = (command, args, execOptions) => {
    calls.push({ command, args, cwd: execOptions.cwd });
    const joined = args.join(" ");
    if (command === "git" && args[0] === "rev-parse") {
      const ok = options.tagged !== false && joined.includes(`refs/tags/v${VERSION}`);
      return { status: ok ? 0 : 1, stdout: ok ? `${RELEASE_SHA}\n` : "" };
    }
    if (command === "git" && args[0] === "log") {
      return { status: 0, stdout: `${RELEASE_SHA}\n` };
    }
    if (command === "git" && joined.startsWith("worktree add")) {
      writeCheckout(args[args.length - 2], options.worktreeVersions ?? sameVersion(VERSION));
      return { status: 0, stdout: "" };
    }
    if (command === "tar") {
      const name = GROUP.find((candidate) =>
        args[1].includes(candidate.replace("@hyperfixation/", "hyperfixation-")),
      );
      return { status: 0, stdout: JSON.stringify({ name }) };
    }
    if (command === "pnpm" && args.includes("pack")) {
      const destination = args[args.indexOf("--pack-destination") + 1];
      mkdirSync(destination, { recursive: true });
      const packed = GROUP.map((name) => ({
        name,
        filename: join(destination, `${name.replace("@hyperfixation/", "hyperfixation-")}-${VERSION}.tgz`),
      }));
      for (const { filename } of packed) writeFileSync(filename, "tarball");
      return { status: 0, stdout: JSON.stringify(packed) };
    }
    return { status: 0, stdout: "" };
  };

  const registry: RegistryClient = {
    url: NPMJS_REGISTRY,
    versionDocument: async (name) => {
      const queued = documents.get(name) ?? [{ status: 404 }];
      return queued.length > 1 ? (queued.shift() as VersionDocument) : queued[0];
    },
  };

  return {
    calls,
    slept,
    documents,
    deps: {
      exec,
      registry,
      integrity: async (tarball) =>
        integrityOf(`@hyperfixation/${/hyperfixation-(?<name>[a-z-]+)-/u.exec(basename(tarball))?.groups?.name ?? "?"}`),
      log: () => {},
      wait: {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    },
  };
}

const options = (): VerifyOptions => ({
  version: VERSION,
  root,
  registry: NPMJS_REGISTRY,
});

describe("verify", () => {
  it("packs a throwaway worktree of the release commit, not the checked-out branch", async () => {
    const harness = fake({});

    expect(await verify(options(), harness.deps)).toEqual([]);

    const added = harness.calls.find((call) => call.args.slice(0, 2).join(" ") === "worktree add");
    expect(added?.args).toContain(RELEASE_SHA);
    const checkout = added?.args[added.args.length - 2] ?? "";
    for (const command of ["install", "build", "pack"]) {
      expect(harness.calls.find((call) => call.args.includes(command))?.cwd).toBe(checkout);
    }
    expect(harness.calls.some((call) => call.command === "pnpm" && call.cwd === root)).toBe(false);
    expect(
      harness.calls.some((call) => call.args.slice(0, 2).join(" ") === "worktree remove"),
    ).toBe(true);
  });

  it("reports the release commit's versions, not the checkout's, when they are wrong", async () => {
    const harness = fake({ worktreeVersions: { ...sameVersion(VERSION), "@hyperfixation/cli": "0.9.9" } });

    const problems = await verify(options(), harness.deps);

    expect(problems[0]).toMatch(/cli is at 0\.9\.9, not 1\.0\.0 at c0ffee1/u);
    expect(problems).toHaveLength(2);
    expect(harness.calls.some((call) => call.args.includes("pack"))).toBe(false);
  });

  it("retries a 404 version document until the publish has propagated", async () => {
    const documents = new Map<string, VersionDocument[]>(
      GROUP.map((name) => [name, [{ status: 200, integrity: integrityOf(name) }]]),
    );
    documents.set("@hyperfixation/cli", [
      { status: 404 },
      { status: 404 },
      { status: 200, integrity: integrityOf("@hyperfixation/cli") },
    ]);
    const harness = fake({ documents });

    expect(await verify(options(), harness.deps)).toEqual([]);
    expect(harness.slept).toEqual([2_000, 4_000]);
  });

  it("reports a package still missing once the propagation window is spent", async () => {
    const documents = new Map<string, VersionDocument[]>(
      GROUP.map((name) => [name, [{ status: 200, integrity: integrityOf(name) }]]),
    );
    documents.set("@hyperfixation/db", [{ status: 404 }]);
    const harness = fake({ documents });

    const problems = await verify(options(), harness.deps);

    expect(problems).toEqual([
      `@hyperfixation/db@${VERSION} is not on ${NPMJS_REGISTRY} (HTTP 404 after 180s)`,
    ]);
    expect(harness.slept.reduce((total, ms) => total + ms, 0)).toBe(PROPAGATION_WINDOW_MS);
  });
});

describe("resolveReleaseCommit", () => {
  it("falls back to the version bump on origin/main when no tag exists", () => {
    const harness = fake({ tagged: false });

    expect(resolveReleaseCommit(harness.deps.exec, root, VERSION)).toEqual({
      sha: RELEASE_SHA,
      source: `the ${VERSION} bump on origin/main`,
    });
  });
});
