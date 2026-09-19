import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The admin runs in the web container on the app's own pool, which the router is handed. It
 * builds no handle of its own, so no export can resolve to the control pool.
 */
describe("the exports map", () => {
  it("publishes exactly one public entry", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };

    expect(Object.keys(manifest.exports)).toEqual(["."]);
  });

  it("builds no pool of its own", async () => {
    for (const entry of [
      "index.ts",
      "router.ts",
      "resource.ts",
      "users.ts",
      "machinery.ts",
      "budget.ts",
    ]) {
      const source = await readFile(path.join(packageRoot, "src", entry), "utf8");
      expect(source).not.toMatch(/new Pool\b/);
      expect(source).not.toMatch(/createStepPool|createControlPool|controlPlaneTx/);
    }
  });
});
