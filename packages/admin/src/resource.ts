import { getTableColumns, getTableName, type Table } from "drizzle-orm";

/**
 * What a UI renders a value as. Deliberately coarse: an admin list shows text, a number, a
 * checkbox, a timestamp, or an opaque blob, and nothing here needs to know that a column is
 * `varchar(64)` rather than `text`.
 */
export type AdminFieldKind = "string" | "number" | "boolean" | "date" | "json";

export interface AdminField {
  /** The Drizzle property name. What a caller names a field by. */
  name: string;
  /** The SQL column, off the metadata, so nothing downstream re-derives the snake_case form. */
  column: string;
  label: string;
  kind: AdminFieldKind;
  nullable: boolean;
  hasDefault: boolean;
  primaryKey: boolean;
  unique: boolean;
}

export interface AdminActionDescriptor {
  name: string;
  label: string;
  /** Phase 1 has one shape: an action against one row. */
  scope: "row";
}

export interface AdminResource {
  name: string;
  /** The SQL table this resource is over. */
  table: string;
  primaryKey: readonly string[];
  fields: readonly AdminField[];
  /** Field names, in order, for the list view. A subset of `fields`. */
  list: readonly string[];
  /** Field names for one row. Every field unless the caller narrows it. */
  view: readonly string[];
  actions: readonly AdminActionDescriptor[];
}

/**
 * Thrown at construction, not at render: `list` and `view` are the one hand-written part of a
 * resource and therefore the one part a column rename can rot.
 */
export class UnknownAdminField extends Error {
  readonly resource: string;
  readonly field: string;
  readonly known: readonly string[];

  constructor(resource: string, field: string, known: readonly string[]) {
    super(
      `UnknownAdminField: the ${resource} resource names ${JSON.stringify(field)}, ` +
        `which its table does not have; it has ${known.join(", ")}`,
    );
    this.name = "UnknownAdminField";
    this.resource = resource;
    this.field = field;
    this.known = known;
  }
}

export interface ResourceFromTableOptions {
  name: string;
  list: readonly string[];
  /** Defaults to every field the table has. */
  view?: readonly string[];
  actions?: readonly AdminActionDescriptor[];
}

const KINDS: Record<string, AdminFieldKind> = {
  string: "string",
  number: "number",
  bigint: "number",
  boolean: "boolean",
  date: "date",
  json: "json",
};

/**
 * An unmapped Drizzle data type degrades to text rather than refusing the whole resource:
 * everything Postgres returns can be shown as text, and a column type nobody taught this
 * function about is not a reason for the admin to stop existing.
 */
function kindOf(dataType: string): AdminFieldKind {
  return KINDS[dataType] ?? "string";
}

/** `banReason` → "Ban reason". Generated, so a new column arrives already labelled. */
function labelOf(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A resource read off the Drizzle table rather than hand-typed beside it, so the fields, their
 * SQL columns, their nullability, defaults, primary key and uniqueness are whatever the schema
 * currently declares. What stays declared is editorial: the resource's name, which fields the
 * list shows and in what order, and which actions it offers — none of which the metadata knows.
 * Those declarations are checked against the metadata here.
 */
export function resourceFromTable(table: Table, options: ResourceFromTableOptions): AdminResource {
  const fields: AdminField[] = Object.entries(getTableColumns(table)).map(([name, column]) => ({
    name,
    column: column.name,
    label: labelOf(name),
    kind: kindOf(column.dataType),
    nullable: !column.notNull,
    hasDefault: column.hasDefault,
    primaryKey: column.primary,
    unique: column.isUnique ?? false,
  }));

  const known = fields.map((field) => field.name);
  const checked = (names: readonly string[]): readonly string[] => {
    for (const name of names) {
      if (!known.includes(name)) throw new UnknownAdminField(options.name, name, known);
    }
    return names;
  };

  return {
    name: options.name,
    table: getTableName(table),
    primaryKey: fields.filter((field) => field.primaryKey).map((field) => field.name),
    fields,
    list: checked(options.list),
    view: options.view === undefined ? known : checked(options.view),
    actions: options.actions ?? [],
  };
}
