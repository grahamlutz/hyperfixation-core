import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * "No export resolves to the control pool" holds here too, and differently: core's
 * control-plane operations take the pool as an argument and `defineApp` closes over whatever
 * the process attached, so this package never builds a handle of its own to publish.
 */
describe("the exports map", () => {
  it("publishes exactly the two public entries", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };

    expect(Object.keys(manifest.exports)).toEqual([".", "./workspace"]);
  });

  it("builds no pool of its own", async () => {
    for (const entry of ["index.ts", "define-app.ts"]) {
      const source = await readFile(path.join(packageRoot, "src", entry), "utf8");
      expect(source).not.toMatch(/new Pool\b/);
      expect(source).not.toMatch(/createControlPool|createStepPool/);
    }
  });
});
