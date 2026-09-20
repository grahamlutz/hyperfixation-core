import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertEnvsCurrent,
  assertRotationApplied,
  envsAreCurrent,
  invalidateStaleSecretSteps,
  runSteps,
  StepInvariantViolated,
  type CloudContext,
  type Step,
} from "./new-cloud.js";
import { openAppState, secretsHash, type AppStateStore, type StepName } from "./state.js";

describe("the cloud hf new step runner", () => {
  let dir: string;
  let state: AppStateStore;
  let context: CloudContext;
  let ran: StepName[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hf-steps-"));
    state = await openAppState("demo-app", { dir });
    context = { state, rotated: false };
    ran = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const recording = (name: StepName): Step => ({
    name,
    run: async () => {
      ran.push(name);
      await Promise.resolve();
    },
  });

  it("runs the steps in order and records each one", async () => {
    const result = await runSteps([recording("template"), recording("install")], context);

    expect(ran).toEqual(["template", "install"]);
    expect(result).toEqual({ ran: ["template", "install"], skipped: [], invalidated: [] });
    expect(state.isDone("install")).toBe(true);
  });

  it("skips a step an earlier run recorded", async () => {
    await state.markDone("template");

    const result = await runSteps([recording("template"), recording("install")], context);

    expect(ran).toEqual(["install"]);
    expect(result.skipped).toEqual(["template"]);
  });

  it("propagates a failure and leaves the step unrecorded, so a rerun repeats it", async () => {
    const failing: Step = {
      name: "install",
      run: () => Promise.reject(new Error("pnpm install exited with code 1")),
    };

    await expect(runSteps([recording("template"), failing, recording("repo")], context)).rejects.toThrow(
      /pnpm install/,
    );

    expect(state.isDone("template")).toBe(true);
    expect(state.isDone("install")).toBe(false);
    expect(ran).toEqual(["template"]);
  });

  it("refuses a step list assembled out of STEPS order", async () => {
    await expect(runSteps([recording("coolify"), recording("database")], context)).rejects.toThrow(
      StepInvariantViolated,
    );

    expect(ran).toEqual([]);
  });

  describe("secrets the Coolify environment carries", () => {
    /** What the `coolify` step of PR 2 does: PATCH the envs, then record what it sent. */
    const recordEnvs = (): Step => ({
      name: "coolify",
      run: async (ctx) => {
        ran.push("coolify");
        await ctx.state.patch({ coolify: { envsSecretsHash: secretsHash(ctx.state.state) } });
      },
    });

    beforeEach(async () => {
      await state.patch({
        database: { migratorPassword: "m1", applicationPassword: "a1" },
        betterAuthSecret: "s1",
      });
    });

    it("keeps coolify done only while the recorded hash matches the current secrets", async () => {
      await runSteps([recordEnvs()], context);
      expect(envsAreCurrent(state.state)).toBe(true);
      expect(await invalidateStaleSecretSteps(state)).toEqual([]);

      await state.patch({ database: { applicationPassword: "a2" } });

      expect(envsAreCurrent(state.state)).toBe(false);
      expect(await invalidateStaleSecretSteps(state)).toEqual(["coolify"]);
      expect(state.isDone("coolify")).toBe(false);
    });

    it("re-PATCHes and redeploys after a rotation, and resumes if the redeploy fails", async () => {
      await runSteps([recordEnvs(), recording("deploy")], context);
      ran.length = 0;

      // The cold-run sequence: `database` rotated, so both recorded steps are stale; the redeploy
      // then fails, which must leave `deploy` to run again rather than recorded against nothing.
      await state.patch({ database: { applicationPassword: "a2" } });
      const failingDeploy: Step = {
        name: "deploy",
        run: () => Promise.reject(new Error("deployment failed")),
      };
      await expect(runSteps([recordEnvs(), failingDeploy], { state, rotated: true })).rejects.toThrow(
        /deployment failed/,
      );
      expect(ran).toEqual(["coolify"]);
      expect(state.isDone("deploy")).toBe(false);

      ran.length = 0;
      const result = await runSteps([recordEnvs(), recording("deploy")], context);

      expect(ran).toEqual(["deploy"]);
      expect(result).toMatchObject({ skipped: ["coolify"], invalidated: [] });
    });

    it("refuses to finish while a rotation has not reached Coolify", async () => {
      await runSteps([recordEnvs()], context);
      await state.patch({ database: { applicationPassword: "a2" } });

      // A step list that never reaches `coolify`: the file it leaves is self-consistent, and the
      // deployed app is on passwords that no longer exist. Only `rotated` can tell.
      const refusal = await runSteps([recording("deploy")], { state, rotated: true }).catch(
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(StepInvariantViolated);
      expect((refusal as Error).message).toMatch(/still holds the old ones/);
      expect(() => assertRotationApplied({ state, rotated: false })).not.toThrow();
    });

    it("refuses a recorded coolify whose secrets have moved on", () => {
      const stale = {
        steps: { coolify: { doneAt: "2026-09-19T00:00:00.000Z" } },
        coolify: { envsSecretsHash: "0".repeat(64) },
        database: { applicationPassword: "a1" },
      };

      expect(() => assertEnvsCurrent(stale)).toThrow(StepInvariantViolated);
      expect(() => assertEnvsCurrent({ ...stale, steps: {} })).not.toThrow();
    });
  });
});
