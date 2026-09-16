import type { QueryConfig, Submittable } from "pg";

export type QueryArg = string | QueryConfig | Submittable;

/**
 * Stands in for a `Submittable` that carries no SQL text of its own. It does not parse, so
 * `classify()` calls it a write.
 */
export const OPAQUE_SUBMITTABLE = "<opaque submittable>";

/**
 * Normalises the three shapes node-pg's `query()` accepts down to the SQL text `classify()` reads.
 * `pg-copy-streams`, `pg-cursor` and `pg-query-stream` all expose their statement as `.text`.
 */
export function extractStatementText(queryArg: QueryArg): string {
  if (typeof queryArg === "string") return queryArg;
  const text = (queryArg as { text?: unknown }).text;
  return typeof text === "string" ? text : OPAQUE_SUBMITTABLE;
}
