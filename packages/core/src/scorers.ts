import type { SpecDefinition } from "./specs.js";

/** What a scorer returns; `writeScore` takes the same fields. */
export interface Scored {
  readonly score: number;
  readonly explanation?: string;
  /** The `hf_llm_call` row behind an LLM-assigned score; a rule-based score has none. */
  readonly llmCallId?: number;
}

export interface ScorerDefinition<R = unknown, C = unknown> {
  readonly name: string;
  readonly recordType: string;
  readonly spec: SpecDefinition<C>;
  score(record: R, criteria: C): Promise<Scored>;
}

export function defineScorer<R, C>(definition: ScorerDefinition<R, C>): ScorerDefinition<R, C> {
  return definition;
}
