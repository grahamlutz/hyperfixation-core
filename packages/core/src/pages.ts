/**
 * A workspace page, keyed by `path`. It says a page exists and what to call it, and nothing
 * about how to draw it: the workspace ships descriptors and the template renders them, so a
 * page carries no component here.
 */
export interface PageDefinition {
  readonly path: string;
  readonly title: string;
  /** In the workspace nav; a page reached only from another page leaves it out. */
  readonly nav?: boolean;
}
