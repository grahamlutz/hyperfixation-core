import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const migrations = fileURLToPath(new URL("../migrations", import.meta.url));
const scratch = "./.drizzle-journal-check";

interface Journal {
  entries: { idx: number; tag: string }[];
}

const readJournal = (dir: string): Journal =>
  JSON.parse(readFileSync(`${dir}/meta/_journal.json`, "utf8")) as Journal;

const baseline = JSON.parse(
  readFileSync(fileURLToPath(new URL("./migrations-journal.baseline.json", import.meta.url)), "utf8"),
) as { tags: string[] };

describe("migrations journal", () => {
  const journal = readJournal(migrations);

  it("is append-only against the committed baseline", () => {
    expect(journal.entries.map((e) => e.tag).slice(0, baseline.tags.length)).toEqual(baseline.tags);
  });

  it("numbers its entries contiguously from zero", () => {
    expect(journal.entries.map((e) => e.idx)).toEqual(journal.entries.map((_, i) => i));
  });

  it("has a SQL file for every entry", () => {
    for (const entry of journal.entries) {
      expect(existsSync(`${migrations}/${entry.tag}.sql`), entry.tag).toBe(true);
    }
  });
});

describe("drizzle-kit generate", () => {
  // Generates into a throwaway copy of the journal: a pending diff shows up as an
  // extra entry there and leaves the committed migrations untouched either way.
  const scratchAbs = `${packageRoot}${scratch.slice(2)}`;

  beforeAll(() => {
    rmSync(scratchAbs, { recursive: true, force: true });
    mkdirSync(scratchAbs, { recursive: true });
    cpSync(migrations, scratchAbs, { recursive: true });
  });

  afterAll(() => {
    rmSync(scratchAbs, { recursive: true, force: true });
  });

  it("finds no pending changes against the committed migrations", () => {
    execFileSync(
      "drizzle-kit",
      ["generate", "--dialect", "postgresql", "--schema", "./src/schema/index.ts", "--out", scratch],
      { cwd: packageRoot, encoding: "utf8" },
    );

    expect(readJournal(scratchAbs).entries.map((e) => e.tag)).toEqual(
      readJournal(migrations).entries.map((e) => e.tag),
    );
  });
});
