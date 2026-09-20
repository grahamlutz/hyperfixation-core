import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDownstream } from "./downstream-matrix.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** The `repositories:` block of the release workflow's app-token step, one name per line. */
function releaseRepositories(workflow: string): string[] {
  const match = /repositories: \|\n((?:\s+[\w.-]+\n)+)/.exec(workflow);
  if (match?.[1] === undefined) throw new Error("no `repositories: |` block in release.yml");
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

describe("release.yml's app token", () => {
  it("lists core and exactly the repos in downstream.txt", () => {
    const listed = releaseRepositories(
      readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8"),
    );
    const downstream = parseDownstream(readFileSync(path.join(ROOT, "downstream.txt"), "utf8")).map(
      (slug) => slug.split("/")[1],
    );
    expect([...listed].sort()).toEqual(["hyperfixation-core", ...downstream].sort());
  });
});
