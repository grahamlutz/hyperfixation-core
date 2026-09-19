/** One row as a source yields it, shaped for `hf_source_record (source, external_id, payload)`. */
export interface SourceRow<P> {
  readonly externalId: string;
  readonly payload: P;
}

export interface SourceDefinition<P = unknown> {
  readonly name: string;
  /** What `defineRecord` calls the records this source produces. */
  readonly recordType: string;
  /** Streamed rather than returned: the loader COPYs it, and a full source need not fit in memory. */
  fetch(): AsyncIterable<SourceRow<P>>;
}

export function defineSource<P>(definition: SourceDefinition<P>): SourceDefinition<P> {
  return definition;
}
