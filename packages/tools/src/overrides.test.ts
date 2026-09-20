import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { withTarballOverrides } from "./overrides.js";

const TARBALLS = new Map([
  ["@hyperfixation/core", "/tmp/packs/hyperfixation-core-0.1.1.tgz"],
  ["@hyperfixation/db", "/tmp/packs/hyperfixation-db-0.1.1.tgz"],
]);

describe("withTarballOverrides", () => {
  it("keeps the template's other settings and its comments", () => {
    const before = [
      "# pnpm 12 refuses any version published less than 24 hours ago.",
      'minimumReleaseAgeExclude:\n  - "@hyperfixation/*"',
      "allowBuilds:\n  esbuild: true",
      "",
    ].join("\n\n");

    const after = withTarballOverrides(before, TARBALLS);

    expect(after).toContain("# pnpm 12 refuses any version");
    expect(parse(after)).toMatchObject({
      minimumReleaseAgeExclude: ["@hyperfixation/*"],
      allowBuilds: { esbuild: true },
      overrides: {
        "@hyperfixation/core": "file:/tmp/packs/hyperfixation-core-0.1.1.tgz",
        "@hyperfixation/db": "file:/tmp/packs/hyperfixation-db-0.1.1.tgz",
      },
    });
  });

  it("replaces the development bridge, including the link: overrides it reaches through", () => {
    const before = [
      "overrides:",
      '  "@hyperfixation/core": "link:../hyperfixation/packages/core"',
      '  "@hyperfixation/admin": "link:../hyperfixation/packages/admin"',
      '  "drizzle-orm": "link:../hyperfixation/packages/db/node_modules/drizzle-orm"',
      '  "left-pad": "1.3.0"',
      "",
    ].join("\n");

    const overrides = parse(withTarballOverrides(before, TARBALLS)).overrides;

    expect(overrides).toEqual({
      "@hyperfixation/core": "file:/tmp/packs/hyperfixation-core-0.1.1.tgz",
      "@hyperfixation/db": "file:/tmp/packs/hyperfixation-db-0.1.1.tgz",
      "left-pad": "1.3.0",
    });
  });

  it("writes an overrides block into a checkout that has no settings file", () => {
    expect(parse(withTarballOverrides("", TARBALLS)).overrides).toEqual({
      "@hyperfixation/core": "file:/tmp/packs/hyperfixation-core-0.1.1.tgz",
      "@hyperfixation/db": "file:/tmp/packs/hyperfixation-db-0.1.1.tgz",
    });
  });
});
