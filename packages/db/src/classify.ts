import { astVisitor, parse, type Statement } from "pgsql-ast-parser";

export type StatementKind = "read" | "write";

/**
 * Real volatility lives in `pg_proc.provolatile`, which a pure function with no connection cannot
 * read; this denylist stands in for it, so it is deliberately incomplete rather than authoritative.
 */
const MUTATING_FUNCTIONS = new Set([
  "pg_notify",
  "setval",
  "nextval",
  "lastval",
  "pg_advisory_lock",
  "pg_advisory_unlock",
  "pg_advisory_xact_lock",
  "dblink_exec",
]);

const cache = new Map<string, StatementKind>();

/**
 * Anything that is not provably a read is a write: unparseable text, transaction control, `SET`,
 * and every statement type the whitelist below omits.
 */
export function classify(sql: string): StatementKind {
  const cached = cache.get(sql);
  if (cached !== undefined) return cached;
  const kind = classifyUncached(sql);
  cache.set(sql, kind);
  return kind;
}

function classifyUncached(sql: string): StatementKind {
  let statements: Statement[];
  try {
    statements = parse(sql);
  } catch {
    return "write";
  }
  if (statements.length === 0) return "write";
  if (!statements.every(isReadStatement)) return "write";
  return callsMutatingFunction(statements) ? "write" : "read";
}

function isReadStatement(statement: Statement): boolean {
  switch (statement.type) {
    case "select":
      // `FOR UPDATE`/`FOR SHARE` take row locks, which only a fenced transaction may hold.
      return !statement.for;
    case "union":
    case "union all":
      return isReadStatement(statement.left) && isReadStatement(statement.right);
    case "values":
    case "show":
      return true;
    case "with":
      return (
        statement.bind.every((b) => isReadStatement(b.statement)) &&
        isReadStatement(statement.in)
      );
    case "with recursive":
      return isReadStatement(statement.bind) && isReadStatement(statement.in);
    default:
      return false;
  }
}

function callsMutatingFunction(statements: Statement[]): boolean {
  let found = false;
  const visitor = astVisitor((self) => ({
    call: (expr) => {
      if (MUTATING_FUNCTIONS.has(expr.function.name.toLowerCase())) found = true;
      self.super().call(expr);
    },
  }));
  for (const statement of statements) visitor.statement(statement);
  return found;
}
