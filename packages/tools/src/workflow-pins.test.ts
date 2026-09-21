import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOWS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.github/workflows",
);

/** A `uses:` line, wherever in the file it sits. */
const USES = /^\s*(?:-\s*)?uses:\s*(?<ref>\S+)(?<rest>.*)$/gmu;

const PINNED = /@[0-9a-f]{40}$/u;
const VERSION_COMMENT = /^\s*#\s*v\d+\.\d+\.\d+/u;

type Use = { readonly file: string; readonly ref: string; readonly rest: string };

function uses(): Use[] {
  const found: Use[] = [];
  for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"))) {
    const text = readFileSync(path.join(WORKFLOWS, file), "utf8");
    for (const match of text.matchAll(USES)) {
      const { ref, rest } = match.groups as { ref: string; rest: string };
      found.push({ file, ref, rest });
    }
  }
  return found;
}

/** A local action is this repo's own code at this repo's own commit; there is nothing to pin. */
function thirdParty(use: Use): boolean {
  return !use.ref.startsWith("./");
}

describe("the actions the workflows run", () => {
  it("has some to check", () => {
    expect(uses().filter(thirdParty).length).toBeGreaterThan(0);
  });

  // A tag is a moving pointer the action's owner can repoint at any commit, including after
  // their account is taken over. R1's supply-chain review: pin the commit, name the tag in a
  // comment so the next bump is a readable diff.
  it("pins every third-party action by commit SHA", () => {
    const floating = uses()
      .filter(thirdParty)
      .filter((use) => !PINNED.test(use.ref))
      .map((use) => `${use.file}: ${use.ref}`);

    expect(floating).toEqual([]);
  });

  it("says which version each SHA is", () => {
    const unlabelled = uses()
      .filter(thirdParty)
      .filter((use) => !VERSION_COMMENT.test(use.rest))
      .map((use) => `${use.file}: ${use.ref}`);

    expect(unlabelled).toEqual([]);
  });
});
