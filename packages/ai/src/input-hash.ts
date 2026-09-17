import { createHash } from "node:crypto";

/**
 * What `input_hash` holds, and so what `LedgerKeyCollision` compares.
 *
 * The prompt is deliberately *not* folded in. A key's cached row has to survive a redeploy that
 * edited the prompt — otherwise every in-flight run's replay would collide on the prompt change
 * rather than replay from its row, which is the one thing the ledger exists to do. The prompt's
 * own identity lives in `prompt_name`/`prompt_hash` (Phase 2).
 */
export function hashInput(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

/** Key order must not change the hash: two callers building the same object are the same call. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
