import type { StepDatabase } from "@hyperfixation/db";
import type { ClientBase } from "pg";

/**
 * The open, fenced client behind a `ctx.tx` handle. `StepDatabase`'s type omits `$client`, so
 * the cast is how the step-side helpers issue the positional-parameter SQL the rest of this
 * package is written in — `loader.ts` reaches for it the same way.
 */
export function stepClient(db: StepDatabase): ClientBase {
  return (db as unknown as { $client: ClientBase }).$client;
}
