import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * This package's own version, read from its `package.json` at runtime.
 *
 * Not a constant the build stamps in: the nine packages are one fixed version group, and a
 * release rewrites `package.json` alone — a baked-in string would be a second copy that is wrong
 * from the next release onwards. `../package.json` resolves the same from `src/` and from `dist/`.
 */
export async function cliVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { version?: unknown };
  return typeof manifest.version === "string" ? manifest.version : "unknown";
}
