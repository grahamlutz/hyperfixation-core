import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bumpDownstream, type BumpDeps } from "./bump-ci.js";
import type { Exec } from "./registry.js";

const GROUP = ["@hyperfixation/db", "@hyperfixation/core", "@hyperfixation/cli"];
const VERSION = "1.0.0";
const TEMPLATE = "grahamlutz/hyperfixation-template";
const TOKEN = "ghs-template-only-token";

type Call = { command: string; args: readonly string[]; env?: NodeJS.ProcessEnv };

type Fake = {
  readonly calls: Call[];
  readonly deps: BumpDeps;
  /** Branches `git ls-remote --heads` reports. */
  readonly remoteBranches: string[];
  /** PR numbers `gh pr list --head` reports. */
  readonly openPrs: number[];
  /** Packages the clone's `pnpm update` leaves at their old version. */
  readonly staleAfterUpdate: string[];
  /** `@hyperfixation/*` specs the cloned app's package.json carries. */
  appDependencies: Record<string, string>;
  /** Whether the pinned `pnpm update` leaves the clone dirty. */
  updateChanges: boolean;
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hf-bump-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fake(options: { token?: string; cloneFails?: boolean } = {}): Fake {
  const calls: Call[] = [];
  const remoteBranches: string[] = [];
  const openPrs: number[] = [];
  const staleAfterUpdate: string[] = [];
  const state = {
    appDependencies: Object.fromEntries(GROUP.map((name) => [name, "^0.9.0"])),
    updateChanges: true,
  };

  const exec: Exec = (command, args, execOptions) => {
    calls.push({ command, args, env: execOptions.env });
    const joined = args.join(" ");
    if (command === "git" && args.includes("ls-remote")) {
      const branch = args[args.length - 1].replace("refs/heads/", "");
      return {
        status: 0,
        stdout: remoteBranches.includes(branch) ? `abc123\trefs/heads/${branch}\n` : "",
      };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      return { status: 0, stdout: JSON.stringify(openPrs.map((number) => ({ number }))) };
    }
    if (command === "git" && args.includes("clone")) {
      if (options.cloneFails === true) return { status: 128, stdout: "" };
      const destination = args[args.length - 1];
      mkdirSync(destination, { recursive: true });
      writeFileSync(
        join(destination, "package.json"),
        JSON.stringify({ name: "app", dependencies: state.appDependencies }),
      );
      return { status: 0, stdout: "" };
    }
    // A real `pnpm update` rewrites both files; the stale names are the 0.1.8 failure.
    if (command === "pnpm" && args[0] === "update") {
      const specs = Object.fromEntries(
        Object.keys(state.appDependencies).map((name) => [
          name,
          staleAfterUpdate.includes(name) ? "^0.9.0" : `^${VERSION}`,
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

  return {
    calls,
    remoteBranches,
    openPrs,
    staleAfterUpdate,
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
    deps: { exec, log: () => {}, token: options.token ?? TOKEN },
  };
}

function bump(harness: Fake, repo = TEMPLATE): Promise<boolean> {
  return bumpDownstream({ repo, version: VERSION, root }, harness.deps);
}

function created(calls: readonly Call[]): Call[] {
  return calls.filter((call) => call.command === "gh" && call.args[1] === "create");
}

describe("bumpDownstream", () => {
  it("opens the bump PR for the repo it was given", async () => {
    const harness = fake();

    expect(await bump(harness)).toBe(true);
    expect(created(harness.calls)).toHaveLength(1);
    expect(created(harness.calls)[0].args).toContain("core-bump/1.0.0");
    expect(created(harness.calls)[0].args).toContain("Bump @hyperfixation/* to 1.0.0");
  });

  // `--latest` resolves whatever the packument names, so it can silently pin the release before.
  // The two `--ignore-*` flags are the fix for R1: `pnpm update` in someone else's checkout would
  // otherwise run that repo's `.pnpmfile.cjs` and dependency build scripts holding this token.
  it("pins the update to the exact version and runs none of the app's own code", async () => {
    const harness = fake();

    await bump(harness);

    const updates = harness.calls.filter(
      (call) => call.command === "pnpm" && call.args[0] === "update",
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].args).toEqual([
      "update",
      "@hyperfixation/*@1.0.0",
      "--ignore-scripts",
      "--ignore-pnpmfile",
    ]);
  });

  it("never puts the token in a URL, and passes it as a transient header instead", async () => {
    const harness = fake();

    await bump(harness);

    const git = harness.calls.filter((call) => call.command === "git");
    expect(git.some((call) => call.args.some((arg) => arg.includes(TOKEN)))).toBe(false);
    expect(git.some((call) => call.args.some((arg) => arg.includes("x-access-token")))).toBe(false);
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
    for (const subcommand of ["ls-remote", "clone", "push"]) {
      const call = git.find((candidate) => candidate.args.includes(subcommand));
      expect(call?.args.slice(0, 2)).toEqual([
        "-c",
        `http.extraheader=AUTHORIZATION: basic ${basic}`,
      ]);
    }
  });

  it("gives the token to gh through the environment only", async () => {
    const harness = fake();

    await bump(harness);

    for (const call of harness.calls.filter((candidate) => candidate.command === "gh")) {
      expect(call.env?.GH_TOKEN).toBe(TOKEN);
      expect(call.args.some((arg) => arg.includes(TOKEN))).toBe(false);
    }
  });

  // Every message quotes the argv, and the argv carries `AUTHORIZATION: basic <base64>`.
  it("keeps the credential out of the message when a clone fails", async () => {
    const harness = fake({ cloneFails: true });
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

    await expect(bump(harness)).rejects.toThrow(/git .* clone .* failed/u);
    await expect(bump(harness)).rejects.not.toThrow(new RegExp(basic, "u"));
    await expect(bump(harness)).rejects.not.toThrow(new RegExp(TOKEN, "u"));
  });

  it("refuses the repo the update left behind", async () => {
    const harness = fake();
    harness.staleAfterUpdate.push("@hyperfixation/cli");

    await expect(bump(harness)).rejects.toThrow(/hyperfixation-template is not wholly on 1\.0\.0/u);
    expect(created(harness.calls)).toHaveLength(0);
  });

  it("opens no bump PR when the branch is already there", async () => {
    const harness = fake();
    harness.remoteBranches.push("core-bump/1.0.0");

    expect(await bump(harness)).toBe(false);
    expect(harness.calls.some((call) => call.args.includes("clone"))).toBe(false);
  });

  // A merged bump PR's branch is deleted, so the branch check alone would reopen it.
  it("opens no bump PR when a PR for that version already existed", async () => {
    const harness = fake();
    harness.openPrs.push(12);

    expect(await bump(harness)).toBe(false);
    expect(harness.calls.some((call) => call.args.includes("clone"))).toBe(false);
  });

  it("commits nothing when the downstream repo is already at the version", async () => {
    const harness = fake();
    harness.updateChanges = false;

    expect(await bump(harness)).toBe(false);
    expect(created(harness.calls)).toHaveLength(0);
  });

  it("opens no bump PR for a repo that depends on no core package", async () => {
    const harness = fake();
    harness.appDependencies = { next: "^15.0.0" };

    expect(await bump(harness)).toBe(false);
    expect(created(harness.calls)).toHaveLength(0);
  });
});
