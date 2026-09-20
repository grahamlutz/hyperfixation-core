import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSteps } from "../new-cloud.js";
import { openAppState, type AppStateStore } from "../state.js";
import {
  createRecordingExec,
  createStepContext,
  isGit,
  type ExecCall,
  type RecordingExec,
} from "../test-support/cloud-step.js";
import { installStep } from "./install.js";

const APP = "demo-app";
const HEAD = "9".repeat(40);

describe("the cloud install step", () => {
  let workspace: string;
  let dir: string;
  let state: AppStateStore;

  /** `git rev-parse HEAD` answers `head`; everything else succeeds. */
  const execWith = (head: string | undefined, failing?: string): RecordingExec =>
    createRecordingExec((call: ExecCall) => {
      if (isGit(call, "rev-parse")) {
        if (head === undefined) return { code: 128, stderr: "fatal: not a git repository" };
        return { stdout: `${head}\n` };
      }
      if (failing !== undefined && call.command === failing) {
        return { code: 1, stderr: "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH" };
      }
      return undefined;
    });

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "hf-install-step-"));
    const stateDir = path.join(workspace, "state");
    await mkdir(stateDir);
    state = await openAppState(APP, { dir: stateDir });

    dir = path.join(workspace, APP);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), '{ "name": "demo_app" }\n');
    await writeFile(path.join(dir, ".gitignore"), ".env\nnode_modules\n");
    await writeFile(path.join(dir, ".env"), "DATABASE_URL=postgres://app:hunter2@localhost/db\n");
    await writeFile(path.join(dir, "src", "hyperfixation.ts"), 'name: "demo_app",\n');
    await mkdir(path.join(dir, "node_modules", "left-behind"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", "left-behind", "index.js"), "");
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("runs nothing at all when an earlier run recorded the step", async () => {
    await state.markDone("install");
    const exec = execWith(undefined);

    await runSteps([installStep], createStepContext({ dir, state, exec: exec.exec }));

    expect(exec.calls).toEqual([]);
  });

  it("installs, initialises main and commits the templated files by name", async () => {
    const exec = execWith(undefined);

    await runSteps([installStep], createStepContext({ dir, state, exec: exec.exec }));

    expect(exec.calls.map((call) => [call.command, ...call.args].join(" "))).toEqual([
      "git rev-parse HEAD",
      "pnpm install",
      "git init -b main",
      "git add -- .gitignore package.json src/hyperfixation.ts",
      `git commit -m Create ${APP} from hyperfixation-template`,
    ]);

    const added = exec.calls.find((call) => isGit(call, "add"))!;
    expect(added.args).not.toContain("-A");
    expect(added.args).not.toContain(".env");
    expect(added.args.some((arg) => arg.startsWith("node_modules"))).toBe(false);
    expect(exec.calls.every((call) => call.options.cwd === dir)).toBe(true);
  });

  it("adopts the commit a previous run made, without a state file", async () => {
    const exec = execWith(HEAD);
    const context = createStepContext({ dir, state, exec: exec.exec });

    await runSteps([installStep], context);

    expect(exec.calls).toHaveLength(1);
    expect(context.lines.join("\n")).toContain("adopting the commit");
  });

  it("leaves the step unrecorded when a command fails", async () => {
    const exec = execWith(undefined, "pnpm");

    await expect(
      runSteps([installStep], createStepContext({ dir, state, exec: exec.exec })),
    ).rejects.toThrow(/pnpm install exited with code 1/);

    expect(state.isDone("install")).toBe(false);
    expect(exec.calls.some((call) => isGit(call, "commit"))).toBe(false);
  });
});
