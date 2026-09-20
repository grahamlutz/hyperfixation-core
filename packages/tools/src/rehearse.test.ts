import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { assertLocalRegistry, RehearsalError, withVersionOverrides } from "./rehearse.js";

const NAMES = ["@hyperfixation/core", "@hyperfixation/db"];

describe("assertLocalRegistry", () => {
  it("accepts a Verdaccio on loopback", () => {
    expect(() => assertLocalRegistry("http://127.0.0.1:4873")).not.toThrow();
    expect(() => assertLocalRegistry("http://localhost:4873")).not.toThrow();
  });

  it("refuses npmjs and anything else off-box", () => {
    for (const url of [
      "https://registry.npmjs.org",
      "https://registry.npmjs.org.evil.test",
      "http://192.168.1.10:4873",
      "not a url",
    ]) {
      expect(() => assertLocalRegistry(url)).toThrow(RehearsalError);
    }
  });
});

describe("withVersionOverrides", () => {
  it("pins the scope to the rehearsed version and keeps the template's other settings", () => {
    const before = [
      "# pnpm 12 refuses any version published less than 24 hours ago.",
      'minimumReleaseAgeExclude:\n  - "@hyperfixation/*"',
      "overrides:\n  \"@hyperfixation/core\": \"^0.1.1\"\n  \"left-pad\": \"1.3.0\"",
      "",
    ].join("\n\n");

    const after = withVersionOverrides(before, NAMES, "0.1.1");

    expect(after).toContain("# pnpm 12 refuses any version");
    expect(parse(after)).toMatchObject({
      minimumReleaseAge: 0,
      minimumReleaseAgeExclude: ["@hyperfixation/*"],
      overrides: {
        "@hyperfixation/core": "0.1.1",
        "@hyperfixation/db": "0.1.1",
        "left-pad": "1.3.0",
      },
    });
  });

  it("replaces a development bridge's link: overrides", () => {
    const before = [
      "overrides:",
      '  "@hyperfixation/core": "link:../hyperfixation/packages/core"',
      '  "drizzle-orm": "link:../hyperfixation/packages/db/node_modules/drizzle-orm"',
      "",
    ].join("\n");

    expect(parse(withVersionOverrides(before, NAMES, "0.2.0")).overrides).toEqual({
      "@hyperfixation/core": "0.2.0",
      "@hyperfixation/db": "0.2.0",
    });
  });
});
