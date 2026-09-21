import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `bump-ci.ts` runs `pnpm update` inside a downstream repo's checkout, so that repo's
 * `.pnpmfile.cjs` and build scripts are the supply-chain risk R1 is about. These two flags are
 * the whole mitigation, and nothing else in this workspace would notice pnpm dropping or renaming
 * one — hence a fixture that runs the real pnpm from `packageManager`.
 */
const GUARDS = ["--ignore-scripts", "--ignore-pnpmfile"];

/** The markers the fixture writes if anything of its own is allowed to run. */
const PNPMFILE_MARKER = "pnpmfile-ran";
const SCRIPT_MARKER = "script-ran";

let fixture: string;

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "hf-pnpm-guards-"));
  await mkdir(join(fixture, "dep"), { recursive: true });
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: {
        preinstall: `node -e "require('fs').writeFileSync('${SCRIPT_MARKER}','1')"`,
        postinstall: `node -e "require('fs').writeFileSync('${SCRIPT_MARKER}','1')"`,
      },
      // `file:` so the fixture resolves with `--offline`: this test is about pnpm's flags, not
      // about the network.
      dependencies: { dep: "file:./dep" },
    }),
  );
  await writeFile(
    join(fixture, "dep/package.json"),
    JSON.stringify({
      name: "dep",
      version: "1.0.0",
      scripts: { postinstall: `node -e "require('fs').writeFileSync('${SCRIPT_MARKER}','1')"` },
    }),
  );
  await writeFile(
    join(fixture, ".pnpmfile.cjs"),
    `require("node:fs").writeFileSync(require("node:path").join(__dirname, "${PNPMFILE_MARKER}"), "1");\n` +
      "module.exports = { hooks: {} };\n",
  );
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

function update(flags: readonly string[]): number {
  const result = spawnSync("pnpm", ["update", "dep", "--offline", ...flags], {
    cwd: fixture,
    encoding: "utf8",
  });
  return result.status ?? 1;
}

function ran(marker: string): boolean {
  return existsSync(join(fixture, marker));
}

describe("the flags `release:bump` passes pnpm update", () => {
  it("runs none of the checkout's own code, and still rewrites the lockfile", () => {
    expect(update(GUARDS)).toBe(0);

    expect(ran(PNPMFILE_MARKER)).toBe(false);
    expect(ran(SCRIPT_MARKER)).toBe(false);
    expect(existsSync(join(fixture, "pnpm-lock.yaml"))).toBe(true);
  });

  // Without the control the test above would pass against a fixture that simply never runs.
  it("is the reason nothing ran: without them the pnpmfile does", () => {
    update([]);

    expect(ran(PNPMFILE_MARKER)).toBe(true);
  });
});
