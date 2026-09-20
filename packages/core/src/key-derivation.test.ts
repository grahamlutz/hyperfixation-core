// Every idempotency/dedupe key a core-shipped helper derives, pinned.
//
// THESE STRINGS ARE PUBLIC CONTRACT, not implementation. A key names rows already committed in
// `hf_activity`, `hf_action_log` and `hf_task.origin_ref`; a run that resumes across a deploy
// rederives its keys and matches them against those rows. Change a template and the match fails,
// so the resumed run writes a second timeline entry and re-sends an action that already went out.
//
// So a diff to this file is never the fix. Changing a derivation is a breaking change under
// planning/hyperfixation-versioning-policy.md — it needs a minor, and the old key has to keep
// working for the runs in flight.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decisionKeyFor, idempotencyKey, sweepDecisionKey } from "@hyperfixation/workflows";
import { describe, expect, it } from "vitest";
import { archiveDecisionKey } from "./records.js";
import { flowOriginRef } from "./tasks.js";

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * The `key:` of every keyed write in a module, verbatim. `scores.ts` and `tasks.ts` build their
 * activity keys inline rather than through an exported helper, so the source text is the only
 * place to pin them — and collecting *all* of them means a new keyed write shows up here as a
 * failure instead of shipping unpinned.
 */
function keyExpressions(file: string): string[] {
  const text = readFileSync(join(SRC, file), "utf8");
  return [...text.matchAll(/^\s*key: ([^\n]*`[^\n]*),$/gm)].map((match) => match[1] ?? "");
}

describe("activity keys", () => {
  it("derives a step's default activity key from the step key and the kind", () => {
    expect(keyExpressions("activity.ts")).toEqual(["options.key ?? `${ctx.key}:${options.kind}`"]);
  });

  it("puts the spec name in a score.written key, so two specs in one step do not collide", () => {
    expect(keyExpressions("scores.ts")).toEqual(["`${key}:score.written:${options.spec.name}`"]);
  });

  it("derives a task.created key from the step key alone", () => {
    expect(keyExpressions("tasks.ts")).toEqual(["`${key}:task.created`"]);
  });
});

describe("derivation helpers", () => {
  it("keys a flow task's origin_ref by run and step key", () => {
    expect(flowOriginRef("run_7", "draft")).toBe("run_7:draft");
  });

  it("keys an action's idempotency by run and step key", () => {
    expect(idempotencyKey("run_7", "draft")).toBe("run_7:draft");
  });

  it("keys an archive decision by record and approval", () => {
    expect(archiveDecisionKey("deal", "41", 9)).toBe("archive:deal:41:9");
  });

  it("keys a sweep decision by approval", () => {
    expect(sweepDecisionKey(9)).toBe("sweep:9");
  });

  it("keys a telegram decision by approval and the nonce of the message that offered it", () => {
    expect(decisionKeyFor({ approvalId: 9, decision: "approved", nonce: "a1b2c3" })).toBe(
      "9:a1b2c3",
    );
  });
});
