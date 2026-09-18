import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import hyperfixation, { BANNED_DBOS_PROPERTIES } from "./index.js";

const linter = new Linter();

function lint(code: string, filename = "src/thing.ts"): Linter.LintMessage[] {
  return linter.verify(code, hyperfixation, filename);
}

function ruleIds(code: string, filename?: string): (string | null)[] {
  return lint(code, filename).map((message) => message.ruleId);
}

describe("the DBOS property ban", () => {
  it.each(BANNED_DBOS_PROPERTIES)("refuses DBOS.%s", (property) => {
    expect(ruleIds(`DBOS.${property}();`)).toEqual(["no-restricted-properties"]);
  });

  it("refuses sendInTransaction on an instance, not just on the class", () => {
    expect(ruleIds("dbosClient.sendInTransaction(handle);")).toEqual(["no-restricted-syntax"]);
    expect(ruleIds("DBOSClient.sendInTransaction(handle);")).toEqual(["no-restricted-syntax"]);
  });

  it("leaves the primitives the run model does use alone", () => {
    expect(ruleIds("await DBOS.runStep(fn, { retriesAllowed: false });")).toEqual([]);
    expect(ruleIds("DBOS.registerQueue('llm', { concurrency: 4 });")).toEqual([]);
  });
});

describe("the deep-import ban", () => {
  it.each([
    'import { x } from "@hyperfixation/db/src/step-pool.js";',
    'import { x } from "@hyperfixation/db/dist/index.js";',
    'import { x } from "@hyperfixation/db/src/internal/control-pool.js";',
    'import { x } from "@hyperfixation/workflows/dist/start-worker.js";',
  ])("refuses %s", (code) => {
    expect(ruleIds(code)).toEqual(["no-restricted-imports"]);
  });

  it("allows the entries the exports maps publish", () => {
    expect(ruleIds('import { createStepPool } from "@hyperfixation/db";')).toEqual([]);
    expect(ruleIds('import { runMigrations } from "@hyperfixation/db/migrator";')).toEqual([]);
  });
});

describe("the raw-handle hint in flows", () => {
  it("fires inside a flows directory", () => {
    expect(ruleIds('import { db } from "@/db";', "src/flows/onboard.ts")).toEqual([
      "no-restricted-imports",
    ]);
  });

  /**
   * Round-3 finding 3: the hint only constrains the importing file, so a helper outside
   * `flows/` importing the same handle is lint-legal. That is why this is a hint and the step
   * pool is the enforcement — asserted here so nobody reads the rule as a backstop.
   */
  it("does not fire on a helper a flow imports", () => {
    expect(ruleIds('import { db } from "@/db";', "src/lib/helper.ts")).toEqual([]);
  });

  it("keeps the deep-import ban that the flows override would otherwise replace", () => {
    expect(
      ruleIds('import { x } from "@hyperfixation/db/src/step-pool.js";', "src/flows/onboard.ts"),
    ).toEqual(["no-restricted-imports"]);
  });
});
