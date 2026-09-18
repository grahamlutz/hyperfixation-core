import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { dev, devBuildSha } from "./dev.js";
import { generate, NoGenerators } from "./gen.js";
import { fakeApp } from "./test-support/fake-app.js";

describe("devBuildSha", () => {
  it("is long enough for startWorker(), which refuses anything under seven characters", () => {
    expect(devBuildSha(1_758_000_000_000).length).toBeGreaterThanOrEqual(7);
  });

  it("changes between restarts, so an edit-and-restart loop is a redeploy to the run model", () => {
    expect(devBuildSha(1)).not.toBe(devBuildSha(2));
  });

  it("is prefixed, so it can never collide with a deployed commit sha", () => {
    expect(devBuildSha()).toMatch(/^dev-\d+$/);
  });
});

describe("hf dev", () => {
  it("brings the infrastructure up and stops when asked for nothing else", async () => {
    const dir = await fakeApp({ appName: "demo_app" });
    try {
      // No `docker-compose.yml` in a fake app, so this runs neither compose nor `pnpm dev`.
      const result = await dev({ dir, composeOnly: true });
      expect(result.buildSha).toMatch(/^dev-/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("hf gen", () => {
  it("refuses an app with no generators rather than running turbo against nothing", async () => {
    const dir = await fakeApp({ appName: "demo_app" });
    try {
      await expect(generate({ dir })).rejects.toThrow(NoGenerators);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
