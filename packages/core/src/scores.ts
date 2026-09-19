import { quoteIdent, type RecordTable } from "@hyperfixation/db";
import type { StepContext } from "@hyperfixation/workflows";
import type { ClientBase, Pool } from "pg";
import { insertActivity } from "./activity.js";
import type { Registry } from "./registry.js";
import type { SpecDefinition } from "./specs.js";
import { stepClient } from "./step-client.js";

/**
 * `DO NOTHING` fires only for a row that carries a `run_id`/`key` pair, which is the partial
 * unique index's predicate: a web-side or untracked write passes null and always inserts.
 */
export const WRITE_SCORE_STATEMENT =
  "INSERT INTO hf_score (record_type, record_id, spec_version, score, explanation, llm_call_id, " +
  "run_id, key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) " +
  "ON CONFLICT (run_id, key) WHERE key IS NOT NULL DO NOTHING RETURNING id";

export const EXISTING_SCORE_STATEMENT = "SELECT id FROM hf_score WHERE run_id = $1 AND key = $2";

/** The mixin's three score columns — the record's current answer, over `hf_score`'s history. */
const scoreMixinStatement = (table: string): string =>
  `UPDATE ${quoteIdent(table)} SET score = $1, score_explanation = $2, spec_version = $3 ` +
  "WHERE id = $4";

export interface WriteScoreOptions {
  recordType: string;
  recordId: string | number;
  spec: SpecDefinition;
  score: number;
  explanation?: string;
  llmCallId?: number;
  /** Set together: `(run_id, key)` is what makes a step-side write survive a replay. */
  runId?: string;
  key?: string;
}

export interface ScoreWritten {
  id: number;
  /** False when a replay found the row its own key had already written. */
  created: boolean;
}

/** What a step hands `scores.write`; the run and the key come from the step. */
export interface StepWriteScoreOptions {
  recordType: string;
  recordId: string | number;
  spec: SpecDefinition;
  score: number;
  explanation?: string;
  llmCallId?: number;
  /** Distinguishes two scores one step writes; defaults to the step's key. */
  key?: string;
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
): Promise<ScoreWritten> {
  const runId = options.runId ?? null;
  const key = options.key ?? null;
  const inserted = await queryable.query<{ id: string }>(WRITE_SCORE_STATEMENT, [
    options.recordType,
    String(options.recordId),
    options.spec.version,
    options.score,
    options.explanation ?? null,
    options.llmCallId ?? null,
    runId,
    key,
  ]);
  if (inserted.rows[0] !== undefined) return { id: Number(inserted.rows[0].id), created: true };

  const found = await queryable.query<{ id: string }>(EXISTING_SCORE_STATEMENT, [runId, key]);
  return { id: Number(found.rows[0]!.id), created: false };
}

/**
 * A scorer's write, inside `ctx.tx`: the `hf_score` row, the record's mixin columns and the
 * timeline entry commit together. The mixin UPDATE is idempotent by construction — it writes the
 * same three values a replay would — so only the insert needs the key.
 */
export async function writeStepScore(
  ctx: StepContext,
  records: Registry<RecordTable>,
  options: StepWriteScoreOptions,
): Promise<ScoreWritten> {
  const { table } = records.require(options.recordType);
  const key = options.key ?? ctx.key;
  const recordId = String(options.recordId);

  return ctx.tx(async (db) => {
    const client = stepClient(db);
    const written = await writeScore(client, { ...options, runId: ctx.runId, key });
    await client.query(scoreMixinStatement(table), [
      options.score,
      options.explanation ?? null,
      options.spec.version,
      recordId,
    ]);
    await insertActivity(client, {
      recordType: options.recordType,
      recordId,
      kind: "score.written",
      runId: ctx.runId,
      key: `${key}:score.written`,
      meta: {
        scoreId: written.id,
        spec: options.spec.name,
        specVersion: options.spec.version,
        score: options.score,
      },
    });
    return written;
  });
}
