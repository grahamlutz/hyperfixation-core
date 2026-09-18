import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const eslintBin = path.join(packageRoot, "node_modules", ".bin", "eslint");

interface LintResult {
  filePath: string;
  errorCount: number;
  messages: { ruleId: string | null; message: string }[];
}

/**
 * Runs the real binary rather than ESLint's Node API: what the case asserts is that `eslint`
 * *fails*, which is an exit code, and the binary is also what resolves `eslint.config.js` the
 * way a developer's editor and CI do.
 */
async function lint(...targets: string[]): Promise<{ code: number; results: LintResult[] }> {
  try {
    const { stdout } = await run(eslintBin, ["--format", "json", ...targets], {
      cwd: packageRoot,
    });
    return { code: 0, results: JSON.parse(stdout) as LintResult[] };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return {
      code: failure.code ?? -1,
      results: JSON.parse(failure.stdout ?? "[]") as LintResult[],
    };
  }
}

function rulesFor(results: LintResult[], fixture: string): string[] {
  const result = results.find((candidate) => candidate.filePath.endsWith(fixture));
  return (result?.messages ?? []).map((message) => message.ruleId ?? "(fatal)");
}

/**
 * Redeploy case 5 — *Bans.* A fixture module calling `DBOS.patch`, `DBOS.recv`, or
 * `dbosClient.sendInTransaction` fails `eslint`. The only gate case with no database
 * dependency at all; the fixtures live in `fixtures/`, outside the `eslint src` the package's
 * own lint script runs, so they fail here and nowhere else.
 */
describe("redeploy case 5 — the banned primitives fail eslint", () => {
  it("exits non-zero on the fixture and names every banned call", async () => {
    const { code, results } = await lint("fixtures/banned-primitives.ts");

    expect(code).toBe(1);
    expect(rulesFor(results, "fixtures/banned-primitives.ts")).toEqual([
      "no-restricted-properties",
      "no-restricted-properties",
      "no-restricted-syntax",
    ]);

    const messages = results.flatMap((result) => result.messages.map((m) => m.message));
    expect(messages.some((m) => m.includes("DBOS.patch"))).toBe(true);
    expect(messages.some((m) => m.includes("DBOS.recv"))).toBe(true);
    expect(messages.some((m) => m.includes("sendInTransaction"))).toBe(true);
  });

  it("refuses the raw handle and the deep import inside a flows directory", async () => {
    const { code, results } = await lint("fixtures/flows/raw-handle.ts");

    expect(code).toBe(1);
    expect(rulesFor(results, "fixtures/flows/raw-handle.ts")).toEqual([
      "no-restricted-imports",
      "no-restricted-imports",
    ]);
  });

  /** The bans are worth nothing if they also refuse the code the run model does use. */
  it("leaves this package's own source clean", async () => {
    const { code, results } = await lint("src");

    expect(results.flatMap((result) => rulesFor([result], result.filePath))).toEqual([]);
    expect(code).toBe(0);
  });
});
