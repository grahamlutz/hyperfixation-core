import type { ClientBase, Pool } from "pg";
import type { SpecDefinition } from "./specs.js";

export const WRITE_SCORE_STATEMENT =
  "INSERT INTO hf_score (record_type, record_id, spec_version, score, explanation, llm_call_id) " +
  "VALUES ($1, $2, $3, $4, $5, $6) RETURNING id";

export interface WriteScoreOptions {
  recordType: string;
  recordId: string | number;
  spec: SpecDefinition;
  score: number;
  explanation?: string;
  llmCallId?: number;
}

/**
 * Always an INSERT, never an UPDATE: `hf_score` is the history of what each spec version
 * thought, so scoring a record again — under this version or the next — adds a row and leaves
 * every earlier one standing.
 *
 * Takes a bare queryable so the step-side `scores.write` can hand it the open `ctx.tx` client;
 * this function neither opens a transaction nor touches the record's mixin columns.
 */
export async function writeScore(
  queryable: Pool | ClientBase,
  options: WriteScoreOptions,
): Promise<{ id: number }> {
  const { rows } = await queryable.query<{ id: string }>(WRITE_SCORE_STATEMENT, [
    options.recordType,
    String(options.recordId),
    options.spec.version,
    options.score,
    options.explanation ?? null,
    options.llmCallId ?? null,
  ]);
  return { id: Number(rows[0]!.id) };
}
