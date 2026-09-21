import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  integrityOfDigest,
  RELEASE_WORKFLOW,
  SOURCE_REPOSITORY,
  type AttestationsResponse,
} from "./attestation.js";
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

/** A real 128-hex digest, so the attestation subject and `dist.integrity` can be the same fact. */
const digestOf = (name: string): string => createHash("sha512").update(name).digest("hex");
const integrityOf = (name: string): string => integrityOfDigest(digestOf(name));

const encode = (statement: unknown): string =>
  Buffer.from(JSON.stringify(statement), "utf8").toString("base64");

type ProvenanceEdits = {
  repository?: string;
  workflow?: string;
  gitCommit?: string;
  digest?: string;
};

/** The two bundles npmjs serves for a `--provenance` publish, with one claim optionally bent. */
function attestationsFor(name: string, edits: ProvenanceEdits = {}): AttestationsResponse {
  const subject = [
    {
      name: `pkg:npm/${name.replace("@", "%40")}@${VERSION}`,
      digest: { sha512: edits.digest ?? digestOf(name) },
    },
  ];
  return {
    attestations: [
      {
        predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
        bundle: {
          dsseEnvelope: {
            payload: encode({
              subject,
              predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
              predicate: { name, version: VERSION, registry: NPMJS_REGISTRY },
            }),
          },
        },
      },
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: {
            payload: encode({
              subject,
              predicateType: "https://slsa.dev/provenance/v1",
              predicate: {
                buildDefinition: {
                  externalParameters: {
                    workflow: {
                      repository: edits.repository ?? SOURCE_REPOSITORY,
                      path: edits.workflow ?? RELEASE_WORKFLOW,
                    },
                  },
                  resolvedDependencies: [
                    { digest: { gitCommit: edits.gitCommit ?? RELEASE_SHA } },
                  ],
                },
                runDetails: { metadata: { invocationId: `${SOURCE_REPOSITORY}/actions/runs/1` } },
              },
            }),
          },
        },
      },
    ],
  };
}

type Harness = {
  readonly calls: Call[];
  readonly deps: VerifyDeps;
  readonly slept: number[];
  /** Version documents answered per package, in order; the last one repeats. */
  readonly documents: Map<string, VersionDocument[]>;
  /** The names handed to the signature audit, or empty when it was skipped. */
  readonly audited: string[][];
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
  /** Per package; a name mapped to `undefined` has no attestation. Default: all attested. */
  attestations?: Map<string, AttestationsResponse | undefined>;
  auditProblems?: string[];
  /** Exit status of the `git fetch` that refreshes origin/main and the tags. Default: 0. */
  fetchStatus?: number;
}): Harness {
  const calls: Call[] = [];
  const slept: number[] = [];
  const audited: string[][] = [];
  const documents =
    options.documents ??
    new Map(GROUP.map((name) => [name, [{ status: 200, integrity: integrityOf(name) }]]));

  const exec: Exec = (command, args, execOptions) => {
    calls.push({ command, args, cwd: execOptions.cwd });
    const joined = args.join(" ");
    if (command === "git" && args[0] === "fetch") {
      return { status: options.fetchStatus ?? 0, stdout: "" };
    }
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

  const attestations =
    options.attestations ?? new Map(GROUP.map((name) => [name, attestationsFor(name)]));

  return {
    calls,
    slept,
    documents,
    audited,
    deps: {
      exec,
      registry,
      integrity: async (tarball) =>
        integrityOf(`@hyperfixation/${/hyperfixation-(?<name>[a-z-]+)-/u.exec(basename(tarball))?.groups?.name ?? "?"}`),
      attestations: async (name) => attestations.get(name),
      audit: async (names) => {
        audited.push([...names]);
        return options.auditProblems ?? [];
      },
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

    expect(await verify(options(), harness.deps)).toEqual({ problems: [], warnings: [] });

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

    const { problems } = await verify(options(), harness.deps);

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

    expect(await verify(options(), harness.deps)).toEqual({ problems: [], warnings: [] });
    expect(harness.slept).toEqual([2_000, 4_000]);
  });

  it("reports a package still missing once the propagation window is spent", async () => {
    const documents = new Map<string, VersionDocument[]>(
      GROUP.map((name) => [name, [{ status: 200, integrity: integrityOf(name) }]]),
    );
    documents.set("@hyperfixation/db", [{ status: 404 }]);
    const harness = fake({ documents });

    const { problems } = await verify(options(), harness.deps);

    expect(problems).toEqual([
      `@hyperfixation/db@${VERSION} is not on ${NPMJS_REGISTRY} (HTTP 404 after ` +
        `${PROPAGATION_WINDOW_MS / 1000}s)`,
    ]);
    expect(harness.slept.reduce((total, ms) => total + ms, 0)).toBe(PROPAGATION_WINDOW_MS);
  });
});

/**
 * A cross-machine build difference: the registry and its attestation agree on the tarball that
 * was published, and only the rebuild on this machine produced other bytes.
 */
function otherBuild(name: string): {
  documents: Map<string, VersionDocument[]>;
  attestations: Map<string, AttestationsResponse | undefined>;
} {
  const digest = digestOf(`${name}-other-build`);
  const documents = new Map<string, VersionDocument[]>(
    GROUP.map((each) => [each, [{ status: 200, integrity: integrityOf(each) }]]),
  );
  documents.set(name, [{ status: 200, integrity: integrityOfDigest(digest) }]);
  const attestations = new Map<string, AttestationsResponse | undefined>(
    GROUP.map((each) => [each, attestationsFor(each)]),
  );
  attestations.set(name, attestationsFor(name, { digest }));
  return { documents, attestations };
}

describe("verify against a provenance attestation", () => {
  it("passes an attested release and audits every attested package's signature", async () => {
    const harness = fake({});

    expect(await verify(options(), harness.deps)).toEqual({ problems: [], warnings: [] });
    expect(harness.audited).toEqual([GROUP]);
  });

  it("fails an attestation built from another commit", async () => {
    const other = "dead10ccdead10ccdead10ccdead10ccdead10cc";
    const harness = fake({
      attestations: new Map([
        ...GROUP.map((name) => [name, attestationsFor(name)] as const),
        ["@hyperfixation/core", attestationsFor("@hyperfixation/core", { gitCommit: other })],
      ]),
    });

    const { problems } = await verify(options(), harness.deps);

    expect(problems).toEqual([
      `@hyperfixation/core@${VERSION} was attested at ${other}, not the release commit ${RELEASE_SHA}`,
    ]);
  });

  it("fails an attestation built by another workflow", async () => {
    const harness = fake({
      attestations: new Map([
        ...GROUP.map((name) => [name, attestationsFor(name)] as const),
        [
          "@hyperfixation/db",
          attestationsFor("@hyperfixation/db", { workflow: ".github/workflows/rogue.yml" }),
        ],
      ]),
    });

    const { problems } = await verify(options(), harness.deps);

    expect(problems).toEqual([
      `@hyperfixation/db@${VERSION} was attested to workflow .github/workflows/rogue.yml, not ${RELEASE_WORKFLOW}`,
    ]);
  });

  it("fails an attestation whose subject digest is not the tarball the registry serves", async () => {
    const harness = fake({
      attestations: new Map([
        ...GROUP.map((name) => [name, attestationsFor(name)] as const),
        [
          "@hyperfixation/cli",
          attestationsFor("@hyperfixation/cli", { digest: digestOf("something else") }),
        ],
      ]),
    });

    const { problems } = await verify(options(), harness.deps);

    expect(problems).toEqual([
      `@hyperfixation/cli@${VERSION} attests ${integrityOf("something else")}, but the registry serves ${integrityOf("@hyperfixation/cli")}`,
    ]);
  });

  it("reports a byte difference as a warning when the attestation verifies", async () => {
    const harness = fake(otherBuild("@hyperfixation/db"));

    const { problems, warnings } = await verify(options(), harness.deps);

    expect(problems).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^@hyperfixation\/db@1\.0\.0 integrity is/u);
    expect(warnings[0]).toMatch(/informational: the provenance attestation covers/u);
  });

  it("falls back to the rebuild comparison, and fails on it, with no attestation", async () => {
    const harness = fake({
      documents: otherBuild("@hyperfixation/db").documents,
      attestations: new Map(GROUP.map((name) => [name, undefined])),
    });

    const { problems, warnings } = await verify(options(), harness.deps);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/has no provenance attestation, so the rebuild is the only check/u);
    expect(problems[0]).toMatch(new RegExp(`\\(rebuilt from ${RELEASE_SHA}, refs/tags/v1\\.0\\.0\\)$`, "u"));
    expect(warnings).toEqual([]);
    // Nothing was attested, so there is no Sigstore bundle to verify.
    expect(harness.audited).toEqual([]);
  });

  it("reports what npm audit signatures rejects", async () => {
    const harness = fake({ auditProblems: ["@hyperfixation/core@1.0.0 failed npm audit signatures"] });

    const { problems } = await verify(options(), harness.deps);

    expect(problems).toEqual(["@hyperfixation/core@1.0.0 failed npm audit signatures"]);
  });
});

describe("fetching before the release commit is resolved", () => {
  it("refreshes origin/main and the tags before reading a ref", async () => {
    const harness = fake({});

    await verify(options(), harness.deps);

    const fetched = harness.calls.findIndex((call) => call.args[0] === "fetch");
    const read = harness.calls.findIndex((call) => call.args[0] === "rev-parse");
    expect(harness.calls[fetched]).toEqual({
      command: "git",
      args: ["fetch", "origin", "main", "--tags", "--quiet"],
      cwd: root,
    });
    expect(fetched).toBeLessThan(read);
  });

  it("stops with the stale-ref explanation when the fetch fails", async () => {
    const harness = fake({ fetchStatus: 1 });

    await expect(verify(options(), harness.deps)).rejects.toThrow(
      /git fetch origin main --tags failed in .*a stale ref reports the wrong commit's tarballs as mismatched/su,
    );
    expect(harness.calls.some((call) => call.args[0] === "rev-parse")).toBe(false);
  });

  it("verifies against the checkout's own refs under --no-fetch", async () => {
    const harness = fake({ fetchStatus: 1 });

    expect(await verify({ ...options(), fetch: false }, harness.deps)).toEqual({
      problems: [],
      warnings: [],
    });
    expect(harness.calls.some((call) => call.args[0] === "fetch")).toBe(false);
  });

  it("names the commit it rebuilt when a tarball does not match", async () => {
    const harness = fake(otherBuild("@hyperfixation/db"));

    const { warnings } = await verify(options(), harness.deps);

    expect(warnings[0]).toMatch(
      new RegExp(`\\(rebuilt from ${RELEASE_SHA}, refs/tags/v1\\.0\\.0\\)$`, "u"),
    );
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
