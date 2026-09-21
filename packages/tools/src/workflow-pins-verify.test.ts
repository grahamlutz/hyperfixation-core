import { describe, expect, it } from "vitest";
import { checkPins, mismatches } from "./workflow-pins-verify.js";

const SHA = "11d5960a326750d5838078e36cf38b85af677262";
const TABLE = { "actions/checkout": { [SHA]: "v4.4.0" } };

describe("pins:verify", () => {
  it("passes a tag that still resolves to the pinned commit", () => {
    expect(mismatches(checkPins(TABLE, () => SHA))).toEqual([]);
  });

  // The case the table exists for: the owner re-tagged, so the pin is no longer what was reviewed.
  it("reports a tag that has been moved to another commit", () => {
    const moved = mismatches(checkPins(TABLE, () => "f".repeat(40)));

    expect(moved).toHaveLength(1);
    expect(moved[0].resolved).toBe("f".repeat(40));
  });

  // A deleted tag, a renamed repo or an unauthenticated `gh` all land here, and none of them is
  // an answer — so none of them passes.
  it("reports a tag it could not resolve at all", () => {
    expect(mismatches(checkPins(TABLE, () => undefined))).toHaveLength(1);
  });

  it("asks about every entry of every action", () => {
    const asked: string[] = [];

    checkPins({ a: { "1": "v1" }, b: { "2": "v2", "3": "v3" } }, (action, version) => {
      asked.push(`${action}@${version}`);
      return undefined;
    });

    expect(asked).toEqual(["a@v1", "b@v2", "b@v3"]);
  });
});
