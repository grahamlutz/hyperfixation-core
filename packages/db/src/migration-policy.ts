import { parse, type AlterTableStatement, type Statement } from "pgsql-ast-parser";

export class MigrationPolicyViolation extends Error {
  readonly statement: string | undefined;

  constructor(message: string, statement?: string) {
    super(message);
    this.name = "MigrationPolicyViolation";
    this.statement = statement;
  }
}

/**
 * Throws unless every statement in an app migration is on the allowlist.
 *
 * Default-deny: a statement kind that is not listed, and any SQL the parser
 * cannot read, is a violation. `CREATE PROCEDURE` reaches the unparseable
 * branch — pgsql-ast-parser has no node for it — and `CREATE FUNCTION` its own;
 * both must be refused however they are spelled, because either can hide a
 * write behind something a later caller reads as a read.
 */
export function assertAppMigrationAllowed(sql: string): void {
  for (const statement of splitStatements(sql)) {
    let parsed: Statement[];
    try {
      parsed = parse(statement);
    } catch (cause) {
      throw new MigrationPolicyViolation(
        `app migrations may not contain SQL the migration policy cannot parse: ${(cause as Error).message}`,
        statement,
      );
    }
    for (const node of parsed) assertStatementAllowed(node, statement);
  }
}

function assertStatementAllowed(node: Statement, statement: string): void {
  switch (node.type) {
    case "create table":
      return;
    case "create index":
      if (node.unique) {
        throw new MigrationPolicyViolation(
          "app migrations may not create unique indexes",
          statement,
        );
      }
      return;
    case "create extension":
      if (!node.ifNotExists) {
        throw new MigrationPolicyViolation(
          "CREATE EXTENSION must be IF NOT EXISTS in an app migration",
          statement,
        );
      }
      return;
    case "alter table":
      assertAlterTableAllowed(node, statement);
      return;
    case "create function":
      throw new MigrationPolicyViolation(
        "app migrations may not contain CREATE FUNCTION",
        statement,
      );
    default:
      throw new MigrationPolicyViolation(
        `app migrations may not contain \`${node.type}\` statements`,
        statement,
      );
  }
}

function assertAlterTableAllowed(node: AlterTableStatement, statement: string): void {
  for (const change of node.changes) {
    switch (change.type) {
      case "add column": {
        const constraints = change.column.constraints ?? [];
        const notNull = constraints.some((c) => c.type === "not null");
        const hasDefault = constraints.some((c) => c.type === "default");
        if (notNull && !hasDefault) {
          throw new MigrationPolicyViolation(
            "ADD COLUMN must be nullable or carry a default in an app migration",
            statement,
          );
        }
        break;
      }
      case "alter column":
        if (change.alter.type !== "drop not null") {
          throw new MigrationPolicyViolation(
            `app migrations may not \`ALTER COLUMN … ${change.alter.type.toUpperCase()}\``,
            statement,
          );
        }
        break;
      default:
        throw new MigrationPolicyViolation(
          `app migrations may not \`ALTER TABLE … ${change.type.toUpperCase()}\``,
          statement,
        );
    }
  }
}

// Drizzle Kit writes one migration file as several statements separated by this
// marker; the parser is happy with either form, but splitting keeps a violation's
// `statement` pointed at the offending statement rather than the whole file.
function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
