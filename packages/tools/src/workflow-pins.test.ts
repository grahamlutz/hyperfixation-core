import { describe, expect, it } from "vitest";
import {
  actionRepo,
  commentVersion,
  PINNED,
  pinnedSha,
  pinTable,
  thirdParty,
  uses,
} from "./workflow-pins.js";

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
      .filter((use) => commentVersion(use) === undefined)
      .map((use) => `${use.file}: ${use.ref}`);

    expect(unlabelled).toEqual([]);
  });

  // The checks above both pass for a wrong SHA wearing a right-looking `# v4.4.0`: nothing in the
  // repo related the two. `workflow-pins.json` is that relation, written down once and asserted
  // everywhere the pin appears — and `pnpm pins:verify` is what resolves it against GitHub.
  it("names every pin in workflow-pins.json, at the same version", () => {
    const table = pinTable();
    const disagreements = uses()
      .filter(thirdParty)
      .flatMap((use) => {
        const labelled = commentVersion(use);
        const recorded = table[actionRepo(use.ref)]?.[pinnedSha(use) ?? ""];
        if (recorded !== undefined && recorded === labelled) return [];
        return [
          `${use.file}: ${use.ref} is labelled ${labelled ?? "nothing"}, the table says ${recorded ?? "nothing"}`,
        ];
      });

    expect(disagreements).toEqual([]);
  });

  // Otherwise the table keeps pins no workflow uses, and stops being a list anyone trusts.
  it("carries no entry the workflows have stopped using", () => {
    const pinned = new Set(
      uses()
        .filter(thirdParty)
        .map((use) => `${actionRepo(use.ref)}@${pinnedSha(use)}`),
    );
    const stale = Object.entries(pinTable()).flatMap(([repo, shas]) =>
      Object.keys(shas)
        .map((sha) => `${repo}@${sha}`)
        .filter((entry) => !pinned.has(entry)),
    );

    expect(stale).toEqual([]);
  });
});
