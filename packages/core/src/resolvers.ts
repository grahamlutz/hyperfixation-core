import type { StepDatabase } from "@hyperfixation/db";
import { InvalidDefinition } from "./registry.js";

export interface ResolverFuzzy {
  /** The record column the candidate query matches on, `normalized_name` in every app so far. */
  readonly field: string;
  /** The payload key compared against `field`, already normalized. Defaults to `field`. */
  readonly payloadKey?: string;
  /** What `pg_trgm.similarity_threshold` is set to for the candidate query; in (0, 1]. */
  readonly threshold: number;
}

export interface ResolverDefinition<P = unknown> {
  readonly name: string;
  readonly recordType: string;
  /** Payload keys joined on before any fuzzy pass; a match on all of them is a link. */
  readonly exactKeys: readonly string[];
  readonly fuzzy?: ResolverFuzzy;
  /** True sends the row to `review` rather than linking it at that similarity. */
  review?(similarity: number): boolean;
  create(payload: P, db: StepDatabase): Promise<{ id: string }>;
  update(id: string, payload: P, db: StepDatabase): Promise<void>;
}

export function defineResolver<P>(definition: ResolverDefinition<P>): ResolverDefinition<P> {
  const threshold = definition.fuzzy?.threshold;
  // 0 matches everything and anything above 1 matches nothing; neither is a resolver anyone meant.
  if (threshold !== undefined && !(threshold > 0 && threshold <= 1)) {
    throw new InvalidDefinition(
      "resolver",
      definition.name,
      `has a fuzzy.threshold of ${threshold}, which is not in (0, 1]`,
    );
  }
  return definition;
}
