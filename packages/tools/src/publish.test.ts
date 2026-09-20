import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publish, type PublishDeps, type PublishOptions } from "./publish.js";
import {
  NPMJS_REGISTRY,
  versionDocumentUrl,
  type Exec,
  type RegistryClient,
  type VersionDocument,
} from "./registry.js";

const GROUP = ["@hyperfixation/db", "@hyperfixation/core", "@hyperfixation/cli"];

/** Mirrors the real dependency direction: db ← core ← cli. */
const MANIFESTS: Record<string, Record<string, string>> = {
  "@hyperfixation/db": {},
  "@hyperfixation/core": { "@hyperfixation/db": "workspace:*" },
  "@hyperfixation/cli": { "@hyperfixation/core": "workspace:*" },
};

type Call = { command: string; args: readonly string[] };

type Fake = {
  readonly calls: Call[];
  readonly deps: PublishDeps;
  readonly documents: Map<string, VersionDocument>;
  readonly answers: string[];
  /** `workspace:` ranges the packed manifests keep, per package name. */
  readonly packedRanges: Map<string, Record<string, string>>;
  npmProfile: string;
  whoamiStatus: number;
};

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "hf-publish-test-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function writeCheckout(root: string, versions: Record<string, string>): Promise<void> {
  await mkdir(join(root, ".changeset"), { recursive: true });
  await writeFile(join(root, ".changeset/config.json"), JSON.stringify({ fixed: [GROUP] }));
  for (const name of GROUP) {
    const dir = join(root, "packages", name.replace("@hyperfixation/", ""));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name, version: versions[name], dependencies: MANIFESTS[name] }),
    );
  }
}

function fake(options: {
  versions?: Record<string, string>;
  published?: readonly string[];
  isTTY?: boolean;
  answers?: string[];
  integrity?: (tarball: string) => Promise<string>;
}): Fake {
  const calls: Call[] = [];
  const documents = new Map<string, VersionDocument>();
  const answers = options.answers ?? ["yes"];
  const packedRanges = new Map<string, Record<string, string>>();
  const state = { npmProfile: JSON.stringify({ tfa: { mode: "auth-and-writes" } }), whoamiStatus: 0 };

  const tarballOf = (name: string): string =>
    join(scratch, "tarballs", `${name.replace("@hyperfixation/", "hyperfixation-")}-1.0.0.tgz`);

  for (const name of options.published ?? []) {
    documents.set(name, { status: 200, integrity: `sha512-${name}` });
  }

  const exec: Exec = (command, args, execOptions) => {
    calls.push({ command, args });
    const joined = args.join(" ");
    if (command === "npm" && joined === "whoami") {
      return { status: state.whoamiStatus, stdout: "maintainer\n" };
    }
    if (command === "npm" && joined.startsWith("profile")) {
      return { status: 0, stdout: state.npmProfile };
    }
    if (command === "tar") {
      const name = GROUP.find((candidate) =>
        args[1].includes(candidate.replace("@hyperfixation/", "hyperfixation-")),
      );
      return {
        status: 0,
        stdout: JSON.stringify({
          name,
          dependencies: packedRanges.get(name ?? "") ?? {},
        }),
      };
    }
    if (command === "pnpm" && args.includes("pack")) {
      // The real `pnpm pack` leaves files behind; the size report stats them.
      const destination = args[args.indexOf("--pack-destination") + 1];
      mkdirSync(destination, { recursive: true });
      const packed = GROUP.map((name) => ({ name, filename: join(destination, basename(tarballOf(name))) }));
      for (const { filename } of packed) writeFileSync(filename, "tarball");
      return { status: 0, stdout: JSON.stringify(packed) };
    }
    if (command === "pnpm" && args.includes("publish") && !args.includes("--dry-run")) {
      const name = args[args.indexOf("--filter") + 1];
      documents.set(name, { status: 200, integrity: `sha512-${name}` });
      return { status: 0, stdout: "" };
    }
    void execOptions;
    return { status: 0, stdout: "" };
  };

  const registry: RegistryClient = {
    url: NPMJS_REGISTRY,
    versionDocument: async (name) => documents.get(name) ?? { status: 404 },
  };

  return {
    calls,
    documents,
    answers,
    packedRanges,
    get npmProfile() {
      return state.npmProfile;
    },
    set npmProfile(value: string) {
      state.npmProfile = value;
    },
    get whoamiStatus() {
      return state.whoamiStatus;
    },
    set whoamiStatus(value: number) {
      state.whoamiStatus = value;
    },
    deps: {
      exec,
      registry,
      clone: async (destination) => {
        await writeCheckout(
          destination,
          options.versions ?? Object.fromEntries(GROUP.map((name) => [name, "1.0.0"])),
        );
      },
      confirm: async () => answers.shift() ?? "",
      isTTY: options.isTTY ?? true,
      log: () => {},
      integrity: options.integrity ?? (async (tarball) => `sha512-@hyperfixation/${nameOf(tarball)}`),
    },
  };
}

function nameOf(tarball: string): string {
  return /hyperfixation-(?<name>[a-z-]+)-1\.0\.0\.tgz$/u.exec(tarball)?.groups?.name ?? "?";
}

const OPTIONS: PublishOptions = {
  version: "1.0.0",
  registry: NPMJS_REGISTRY,
  dryRun: false,
  yes: false,
  keep: false,
};

describe("publish", () => {
  it("publishes the group in dependency order and reports the dispatch command", async () => {
    const harness = fake({});

    const result = await publish(OPTIONS, harness.deps);

    expect(result.published).toEqual([
      "@hyperfixation/db",
      "@hyperfixation/core",
      "@hyperfixation/cli",
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("stops when a package's version is not the one being released", async () => {
    const harness = fake({
      versions: {
        "@hyperfixation/db": "1.0.0",
        "@hyperfixation/core": "0.9.9",
        "@hyperfixation/cli": "1.0.0",
      },
    });

    await expect(publish(OPTIONS, harness.deps)).rejects.toThrow(/core is at 0\.9\.9, not 1\.0\.0/u);
  });

  it("stops when a packed manifest still carries a workspace: range", async () => {
    const harness = fake({});
    harness.packedRanges.set("@hyperfixation/core", { "@hyperfixation/db": "workspace:*" });

    await expect(publish(OPTIONS, harness.deps)).rejects.toThrow(/still workspace:\*/u);
  });

  it("explains the 403 when npm 2FA does not cover writes", async () => {
    const harness = fake({});
    harness.npmProfile = JSON.stringify({ tfa: { mode: "auth-only" } });

    await expect(publish(OPTIONS, harness.deps)).rejects.toThrow(/not auth-and-writes/u);
  });

  it("stops when npm is not logged in", async () => {
    const harness = fake({});
    harness.whoamiStatus = 1;

    await expect(publish(OPTIONS, harness.deps)).rejects.toThrow(/npm whoami/u);
  });

  it("refuses to publish to npmjs without a TTY", async () => {
    const harness = fake({ isTTY: false });

    await expect(publish(OPTIONS, harness.deps)).rejects.toThrow(/not a TTY/u);
    expect(harness.calls).toEqual([]);
  });

  it("refuses --yes against npmjs", async () => {
    const harness = fake({});

    await expect(publish({ ...OPTIONS, yes: true }, harness.deps)).rejects.toThrow(/typed yes/u);
  });

  it("publishes nothing without the typed yes", async () => {
    const harness = fake({ answers: ["no"] });

    await expect(publish(OPTIONS, harness.deps)).rejects.toThrow(/Not confirmed/u);
    expect(harness.calls.filter((call) => isRealPublish(call))).toEqual([]);
  });

  it("skips a package the registry already has and resumes the rest", async () => {
    const harness = fake({ published: ["@hyperfixation/db"] });

    const result = await publish(OPTIONS, harness.deps);

    expect(result.skipped).toEqual(["@hyperfixation/db"]);
    expect(result.published).toEqual(["@hyperfixation/core", "@hyperfixation/cli"]);
    expect(
      harness.calls.filter(isRealPublish).map((call) => call.args[call.args.indexOf("--filter") + 1]),
    ).toEqual(["@hyperfixation/core", "@hyperfixation/cli"]);
  });

  it("fails the final verification when the registry's integrity differs", async () => {
    const harness = fake({ integrity: async () => "sha512-something-else" });

    await expect(publish(OPTIONS, harness.deps)).rejects.toThrow(/integrity is/u);
  });

  it("stops after the dry run when asked to", async () => {
    const harness = fake({});

    const result = await publish({ ...OPTIONS, dryRun: true }, harness.deps);

    expect(result.published).toEqual([]);
    expect(harness.calls.filter(isRealPublish)).toEqual([]);
  });

  it("skips the npmjs-only guards against a local registry", async () => {
    const harness = fake({ isTTY: false });

    const result = await publish(
      { ...OPTIONS, registry: "http://127.0.0.1:4873", yes: true },
      { ...harness.deps, registry: { ...harness.deps.registry, url: "http://127.0.0.1:4873" } },
    );

    expect(result.published).toHaveLength(GROUP.length);
    expect(harness.calls.some((call) => call.args.includes("profile"))).toBe(false);
    expect(harness.calls.some((call) => call.args.includes("--registry"))).toBe(true);
  });
});

function isRealPublish(call: Call): boolean {
  return (
    call.command === "pnpm" && call.args.includes("publish") && !call.args.includes("--dry-run")
  );
}

describe("versionDocumentUrl", () => {
  it("escapes the scope so the path is the per-version document", () => {
    expect(versionDocumentUrl(NPMJS_REGISTRY, "@hyperfixation/core", "0.1.1")).toBe(
      "https://registry.npmjs.org/@hyperfixation%2fcore/0.1.1",
    );
  });
});
