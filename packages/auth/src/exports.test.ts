import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * "No export resolves to the control pool" holds here by the same argument as in core: auth is
 * ordinary web-request-path code, it takes the app's own pool as an argument, and it builds no
 * handle of its own to publish.
 */
describe("the exports map", () => {
  it("publishes exactly one public entry", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };

    expect(Object.keys(manifest.exports)).toEqual(["."]);
  });

  it("builds no pool of its own", async () => {
    for (const entry of ["index.ts", "factory.ts", "bootstrap.ts", "reset-second-factor.ts"]) {
      const source = await readFile(path.join(packageRoot, "src", entry), "utf8");
      expect(source).not.toMatch(/new Pool\b/);
      expect(source).not.toMatch(/createStepPool|createControlPool|controlPlaneTx/);
    }
  });
});
