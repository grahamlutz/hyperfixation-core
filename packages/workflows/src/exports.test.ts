import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * "No export resolves to the control pool" holds for this package too: `startWorker()` is
 * the only way to obtain one, so an app that imports `@hyperfixation/workflows` cannot build
 * itself an unfenced handle on the application database.
 */
describe("the exports map", () => {
  it("publishes exactly one public entry", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };

    expect(Object.keys(manifest.exports)).toEqual(["."]);
  });

  it("keeps the control-pool factory off it", async () => {
    const source = await readFile(path.join(packageRoot, "src", "index.ts"), "utf8");

    expect(source).not.toMatch(/export \{[^}]*\bcreateControlPool\b/s);
  });
});
