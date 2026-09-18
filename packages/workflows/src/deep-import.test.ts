import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const tscBin = createRequire(import.meta.url).resolve("typescript/bin/tsc");

const LEGAL = ["@hyperfixation/db", "@hyperfixation/db/migrator"];
const ILLEGAL = [
  "@hyperfixation/db/src/step-pool.js",
  "@hyperfixation/db/dist/step-pool.js",
  "@hyperfixation/db/src/internal/control-pool.js",
  "@hyperfixation/testing/src/spawn-worker.js",
];

/**
 * The deep-import fixture. The ESLint rule catches the same mistake earlier, but only in files
 * this repo lints; the `exports` map refuses it in any file anywhere, and that refusal is what
 * "apps import only the public API" actually rests on. So this asserts on the resolver.
 *
 * The fixture is compiled against the built `dist/` — `turbo run test` depends on `^build` —
 * which matters for the `dist/*` line: it is refused while the file it names exists.
 */
describe("the deep-import fixture", () => {
  it("fails tsc on every import that reaches past an exports map", async () => {
    const { code, output } = await typecheck();

    expect(code).toBe(2);
    for (const specifier of ILLEGAL) {
      expect(output).toContain(`error TS2307: Cannot find module '${specifier}'`);
    }
  });

  it("resolves the public entries, so the failure is the map and not a broken build", async () => {
    const { output } = await typecheck();

    for (const specifier of LEGAL) {
      expect(output).not.toContain(`'${specifier}'`);
    }
    expect(output.match(/error TS/g)).toHaveLength(ILLEGAL.length);
  });
});

async function typecheck(): Promise<{ code: number; output: string }> {
  try {
    const { stdout } = await run(process.execPath, [tscBin, "-p", "fixtures/deep-import"], {
      cwd: packageRoot,
    });
    return { code: 0, output: stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}
