import { InvalidDefinition } from "./registry.js";

/**
 * What a scorer scores against, versioned. One live version per name: `hf_score.spec_version`
 * and the record mixin's `spec_version` carry the number of the spec a stored score was written
 * under, so a new version adds rows and never rewrites what the old one decided.
 */
export interface SpecDefinition<C = unknown> {
  readonly name: string;
  /** An integer of at least 1, bumped whenever `criteria` changes meaning. */
  readonly version: number;
  readonly criteria: C;
}

export function defineSpec<C>(definition: SpecDefinition<C>): SpecDefinition<C> {
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new InvalidDefinition(
      "spec",
      definition.name,
      `has a version of ${definition.version}, which is not an integer of at least 1`,
    );
  }
  return definition;
}
