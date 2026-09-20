import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSteps } from "../new-cloud.js";
import { TEMPLATE_MARKER, TemplateError } from "../new.js";
import { openAppState, type AppStateStore } from "../state.js";
import { createStepContext, type TestStepContext } from "../test-support/cloud-step.js";
import { exists } from "./context.js";
import { templateStep, templateTempDir } from "./template.js";

const APP = "demo-app";

describe("the cloud template step", () => {
  let workspace: string;
  let stateDir: string;
  let state: AppStateStore;
  let dir: string;
  let fetched: string[];

  /** What giget would leave: a template checkout, marker and placeholders included. */
  const writeTemplate = async (into: string): Promise<string> => {
    await mkdir(path.join(into, "src"), { recursive: true });
    await writeFile(path.join(into, TEMPLATE_MARKER), "placeholders:\n  - __APP_NAME__\n");
    await writeFile(path.join(into, "package.json"), '{ "name": "__APP_NAME__" }\n');
    await writeFile(path.join(into, ".env.example"), "DATABASE_URL=postgres://…/__DB_NAME__\n");
    await writeFile(path.join(into, "src", "hyperfixation.ts"), 'name: "__APP_NAME__",\n');
    return into;
  };

  const contextWith = (
    fetchTemplate: (source: string | undefined, into: string) => Promise<string>,
  ): TestStepContext => createStepContext({ dir, state, fetchTemplate });

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "hf-template-step-"));
    stateDir = path.join(workspace, "state");
    await mkdir(stateDir);
    state = await openAppState(APP, { dir: stateDir });
    dir = path.join(workspace, APP);
    fetched = [];
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  const recordingFetch = async (_source: string | undefined, into: string): Promise<string> => {
    fetched.push(into);
    return await writeTemplate(into);
  };

  it("issues no fetch at all when an earlier run recorded the step", async () => {
    await state.markDone("template");

    await runSteps([templateStep], contextWith(recordingFetch));

    expect(fetched).toEqual([]);
    expect(await exists(dir)).toBe(false);
  });

  it("fetches into a temp directory, substitutes, and renames into place", async () => {
    const context = contextWith(recordingFetch);

    await runSteps([templateStep], context);

    expect(fetched).toEqual([templateTempDir(dir)]);
    expect(await readFile(path.join(dir, "package.json"), "utf8")).toBe('{ "name": "demo_app" }\n');
    expect(await readFile(path.join(dir, "src", "hyperfixation.ts"), "utf8")).toBe(
      'name: "demo_app",\n',
    );
    const entries = await readdir(dir);
    expect(entries).not.toContain(TEMPLATE_MARKER);
    // The cloud app's values live in Coolify; a `.env` here would be a second copy on the laptop.
    expect(entries).not.toContain(".env");
    expect(await exists(templateTempDir(dir))).toBe(false);
  });

  it("leaves nothing at the target when the fetch dies half way, and a rerun succeeds", async () => {
    const crashing = async (_source: string | undefined, into: string): Promise<string> => {
      await writeTemplate(into);
      throw new Error("giget: connection reset");
    };

    await expect(runSteps([templateStep], contextWith(crashing))).rejects.toThrow(/connection reset/);

    expect(await exists(dir)).toBe(false);
    expect(state.isDone("template")).toBe(false);

    await runSteps([templateStep], contextWith(recordingFetch));
    expect(await readFile(path.join(dir, "package.json"), "utf8")).toContain("demo_app");
  });

  it("adopts a directory that is already this app", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), '{ "name": "demo_app" }\n');
    const context = contextWith(recordingFetch);

    await runSteps([templateStep], context);

    expect(fetched).toEqual([]);
    expect(context.lines.join("\n")).toContain("adopting the app directory");
  });

  it("refuses a directory that is something else, and one that is still a template", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), '{ "name": "someone-elses-app" }\n');

    await expect(runSteps([templateStep], contextWith(recordingFetch))).rejects.toThrow(
      TemplateError,
    );

    await writeFile(path.join(dir, "package.json"), '{ "name": "demo_app" }\n');
    await writeFile(path.join(dir, TEMPLATE_MARKER), "");

    await expect(runSteps([templateStep], contextWith(recordingFetch))).rejects.toThrow(
      /will not write into it/,
    );
    expect(fetched).toEqual([]);
  });
});
