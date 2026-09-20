import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, type Statement } from "pgsql-ast-parser";
import { afterAll, describe, expect, it } from "vitest";

const migrations = fileURLToPath(new URL("../migrations", import.meta.url));

const committedAllow = JSON.parse(
  readFileSync(fileURLToPath(new URL("./migration-additivity.allow.json", import.meta.url)), "utf8"),
) as { entries: AllowEntry[] };

interface AllowEntry {
  file: string;
  reason: string;
  replacedIn: string;
}

interface Violation {
  file: string;
  statement: string;
  reason: string;
}

function journalTags(dir: string): string[] {
  const journal = JSON.parse(readFileSync(path.join(dir, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  return journal.entries.map((e) => e.tag);
}

// Drizzle Kit writes a migration as statements separated by this marker. The marker is itself a
// `--` comment, so it has to come off before comments are stripped.
function statementsOf(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map(stripCommentsAndStrings)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

function collapse(statement: string): string {
  return statement.replace(/\s+/g, " ").trim();
}

// An empty result means the statement did not parse: 0001 is hand-written and uses an `INCLUDE`
// clause pgsql-ast-parser has no node for. Those statements fall back to a text scan rather than
// failing the run — a parser gap is not a policy violation.
function parsed(statement: string): Statement[] {
  try {
    return parse(statement);
  } catch {
    return [];
  }
}

interface FileContext {
  /**
   * Index and constraint names this same migration creates. Dropping one of those drops
   * something no release ever ran, so it is additive against N-1.
   */
  namesCreatedHere: Set<string>;
  /** Columns this migration adds itself, so a SET NOT NULL on them touches nothing that shipped. */
  columnsIntroduced: Set<string>;
  columnsDefaulted: Set<string>;
}

const columnKey = (table: string, column: string): string => `${table}.${column}`;

function contextOf(sql: string): FileContext {
  const namesCreatedHere = new Set<string>();
  const columnsIntroduced = new Set<string>();
  const columnsDefaulted = new Set<string>();

  for (const statement of statementsOf(sql)) {
    const nodes = parsed(statement);
    if (nodes.length === 0) {
      const name = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w$]+)"?/i.exec(statement);
      if (name?.[1]) namesCreatedHere.add(name[1]);
      continue;
    }
    for (const node of nodes) {
      if (node.type === "create index" && node.indexName) namesCreatedHere.add(node.indexName.name);
      if (node.type === "create table") {
        for (const column of node.columns) {
          if (column.kind === "column") columnsIntroduced.add(columnKey(node.name.name, column.name.name));
        }
      }
      if (node.type !== "alter table") continue;
      for (const change of node.changes) {
        if (change.type === "add constraint" && change.constraint.constraintName) {
          namesCreatedHere.add(change.constraint.constraintName.name);
        }
        if (change.type === "add column") {
          columnsIntroduced.add(columnKey(node.table.name, change.column.name.name));
        }
        if (change.type === "alter column" && change.alter.type === "set default") {
          columnsDefaulted.add(columnKey(node.table.name, change.column.name));
        }
      }
    }
  }
  return { namesCreatedHere, columnsIntroduced, columnsDefaulted };
}

function scanStatement(statement: string, context: FileContext): string[] {
  const nodes = parsed(statement);
  if (nodes.length === 0) return scanText(statement, context);

  const reasons: string[] = [];
  for (const node of nodes) {
    if (node.type === "drop table") reasons.push("DROP TABLE");
    if (node.type === "drop index") {
      for (const name of node.names) {
        if (!context.namesCreatedHere.has(name.name)) {
          reasons.push(`DROP INDEX on the released index "${name.name}"`);
        }
      }
    }
    if (node.type !== "alter table") continue;
    for (const change of node.changes) {
      switch (change.type) {
        case "drop column":
          reasons.push(`DROP COLUMN "${change.column.name}"`);
          break;
        case "rename":
          reasons.push(`RENAME of table "${node.table.name}"`);
          break;
        case "rename column":
          reasons.push(`RENAME COLUMN "${change.column.name}"`);
          break;
        case "drop constraint":
          if (!context.namesCreatedHere.has(change.constraint.name)) {
            reasons.push(`DROP CONSTRAINT on the released constraint "${change.constraint.name}"`);
          }
          break;
        case "alter column":
          if (change.alter.type === "set type") {
            reasons.push(`ALTER COLUMN "${change.column.name}" TYPE`);
          } else if (
            change.alter.type === "set not null" &&
            !context.columnsIntroduced.has(columnKey(node.table.name, change.column.name)) &&
            !context.columnsDefaulted.has(columnKey(node.table.name, change.column.name))
          ) {
            reasons.push(`SET NOT NULL on the existing column "${change.column.name}" without a default`);
          }
          break;
        default:
          break;
      }
    }
  }
  return reasons;
}

function scanText(statement: string, context: FileContext): string[] {
  const reasons: string[] = [];
  if (/\bDROP\s+TABLE\b/i.test(statement)) reasons.push("DROP TABLE");
  if (/\bDROP\s+COLUMN\b/i.test(statement)) reasons.push("DROP COLUMN");
  if (/\bRENAME\b/i.test(statement)) reasons.push("RENAME");
  if (/\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(statement)) {
    reasons.push("ALTER COLUMN … TYPE");
  }
  if (/\bSET\s+NOT\s+NULL\b/i.test(statement)) {
    reasons.push("SET NOT NULL on an existing column without a default");
  }
  const dropped = /\bDROP\s+(?:CONSTRAINT|INDEX)\s+(?:IF\s+EXISTS\s+)?"?([\w$]+)"?/i.exec(statement)?.[1];
  if (dropped && !context.namesCreatedHere.has(dropped)) {
    reasons.push(`DROP of the released object "${dropped}"`);
  }
  return reasons;
}

/**
 * Every non-additive statement in the core migrations, minus the files an allowlist entry
 * excuses. The policy is "additive against N-1's readers", and a migration is only ever read
 * once it is committed, so the check covers the whole journal rather than a release boundary:
 * a boundary derived from git tags is not there to be read in a shallow clone, and one derived
 * from `migrations-journal.baseline.json` grows in the very PR that adds a migration, which
 * would let the migration under review exempt itself.
 */
function additivityViolations(dir: string, allow: AllowEntry[] = []): Violation[] {
  const excused = new Set(allow.map((e) => e.file));
  const violations: Violation[] = [];

  for (const tag of journalTags(dir)) {
    const file = `${tag}.sql`;
    if (excused.has(file)) continue;
    const sql = readFileSync(path.join(dir, file), "utf8");
    const context = contextOf(sql);
    for (const statement of statementsOf(sql)) {
      for (const reason of scanStatement(statement, context)) {
        violations.push({ file, statement: collapse(statement), reason });
      }
    }
  }
  return violations;
}

const describeViolation = (v: Violation): string => `${v.file}: ${v.reason} — ${v.statement}`;

const scratchDirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hf-additivity-"));
  scratchDirs.push(dir);
  mkdirSync(path.join(dir, "meta"), { recursive: true });
  const tags = Object.keys(files);
  writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: tags.map((tag, idx) => ({ idx, version: "7", when: idx + 1, tag, breakpoints: true })),
    }),
  );
  for (const [tag, sql] of Object.entries(files)) writeFileSync(path.join(dir, `${tag}.sql`), sql);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe("core migration additivity", () => {
  const shipped = { "0000_base": 'CREATE TABLE "hf_thing" ("id" text PRIMARY KEY, "note" text);' };

  it("fails a bare DROP COLUMN, naming the file and the statement", () => {
    const dir = fixture({ ...shipped, "0001_drop": 'ALTER TABLE "hf_thing" DROP COLUMN "note";' });

    expect(additivityViolations(dir).map(describeViolation)).toEqual([
      '0001_drop.sql: DROP COLUMN "note" — ALTER TABLE "hf_thing" DROP COLUMN "note";',
    ]);
  });

  it("passes the same DROP COLUMN once the allowlist excuses it", () => {
    const dir = fixture({ ...shipped, "0001_drop": 'ALTER TABLE "hf_thing" DROP COLUMN "note";' });

    expect(
      additivityViolations(dir, [
        { file: "0001_drop.sql", reason: "replaced by note_v2", replacedIn: "0.1.5" },
      ]),
    ).toEqual([]);
  });

  it("passes additive statements", () => {
    const dir = fixture({
      ...shipped,
      "0001_additive": [
        'ALTER TABLE "hf_thing" ADD COLUMN "label" text;--> statement-breakpoint',
        'CREATE TABLE "hf_other" ("id" text PRIMARY KEY);--> statement-breakpoint',
        'CREATE INDEX "hf_thing_label_idx" ON "hf_thing" USING btree ("label");',
      ].join("\n"),
    });

    expect(additivityViolations(dir)).toEqual([]);
  });

  it("ignores a destructive statement that is only text in a comment", () => {
    const dir = fixture({
      ...shipped,
      "0001_commented": [
        '-- DROP COLUMN "note" was considered here and rejected',
        'ALTER TABLE "hf_thing" ADD COLUMN "label" text;',
      ].join("\n"),
    });

    expect(additivityViolations(dir)).toEqual([]);
  });

  it("ignores a destructive statement that is only text in a string literal", () => {
    const dir = fixture({
      ...shipped,
      "0001_literal": `INSERT INTO "hf_thing" ("id", "note") VALUES ('1', 'DROP TABLE hf_thing');`,
    });

    expect(additivityViolations(dir)).toEqual([]);
  });

  it("allows dropping an index the same migration creates", () => {
    const dir = fixture({
      ...shipped,
      "0001_reindex": [
        'CREATE INDEX "hf_thing_note_idx" ON "hf_thing" USING btree ("note");--> statement-breakpoint',
        'DROP INDEX "hf_thing_note_idx";',
      ].join("\n"),
    });

    expect(additivityViolations(dir)).toEqual([]);
  });

  it("flags dropping an index an earlier migration shipped", () => {
    const dir = fixture({
      ...shipped,
      "0001_index": 'CREATE INDEX "hf_thing_note_idx" ON "hf_thing" USING btree ("note");',
      "0002_drop_index": 'DROP INDEX "hf_thing_note_idx";',
    });

    expect(additivityViolations(dir).map((v) => v.reason)).toEqual([
      'DROP INDEX on the released index "hf_thing_note_idx"',
    ]);
  });

  it("flags SET NOT NULL on a shipped column but not on one the migration adds", () => {
    const dir = fixture({
      ...shipped,
      "0001_not_null": [
        'ALTER TABLE "hf_thing" ADD COLUMN "label" text;--> statement-breakpoint',
        'ALTER TABLE "hf_thing" ALTER COLUMN "label" SET NOT NULL;--> statement-breakpoint',
        'ALTER TABLE "hf_thing" ALTER COLUMN "note" SET NOT NULL;',
      ].join("\n"),
    });

    expect(additivityViolations(dir).map((v) => v.reason)).toEqual([
      'SET NOT NULL on the existing column "note" without a default',
    ]);
  });

  it("holds for the committed core migrations", () => {
    expect(additivityViolations(migrations, committedAllow.entries).map(describeViolation)).toEqual([]);
  });

  it("carries no allowlist entry that has gone stale", () => {
    const files = new Set(readdirSync(migrations).filter((f) => f.endsWith(".sql")));

    for (const entry of committedAllow.entries) {
      expect(files.has(entry.file), entry.file).toBe(true);
      expect(entry.reason.length, entry.file).toBeGreaterThan(0);
      expect(entry.replacedIn, entry.file).toMatch(/^\d+\.\d+\.\d+$/);
      // An entry that excuses nothing is one nobody has to justify again: drop it instead.
      expect(additivityViolations(migrations).map((v) => v.file), entry.file).toContain(entry.file);
    }
  });
});
