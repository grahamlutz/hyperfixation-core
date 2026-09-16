import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = path.join(packageRoot, "src");

async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(sourceRoot, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * "No export resolves to the control pool" is contract surface, so it gets a check rather
 * than a convention: nothing outside `src/internal` may import from it, which makes the
 * control pool unreachable through either entry the `exports` map publishes.
 */
describe("the exports map", () => {
  it("publishes exactly the two public entries", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };

    expect(Object.keys(manifest.exports)).toEqual([".", "./migrator", "./package.json"]);
  });

  it("leaves src/internal unreachable from every module outside it", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      if (file.includes(`${path.sep}internal${path.sep}`)) continue;
      const source = await readFile(file, "utf8");
      if (/from "[^"]*internal\//.test(source)) offenders.push(path.relative(sourceRoot, file));
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the tagging capability off both entries", async () => {
    for (const entry of ["index.ts", "migrator.ts"]) {
      const source = await readFile(path.join(sourceRoot, entry), "utf8");
      expect(source).not.toContain("tagForTransaction");
    }
  });
});
