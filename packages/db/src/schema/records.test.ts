import { getTableConfig, pgTable, bigint } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { hfRecordColumns } from "./records.js";

// Pins the mixin's shape: an app spreads it into an existing table, so a column that turned
// NOT NULL without a default, or unique, would make adopting it a breaking app migration.
describe("hfRecordColumns", () => {
  const table = pgTable("snapshot_record", {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    ...hfRecordColumns(),
  });
  const columns = getTableConfig(table).columns.filter((c) => c.name !== "id");

  it("matches the committed snapshot", () => {
    expect(
      columns.map((c) => ({
        name: c.name,
        type: c.getSQLType(),
        notNull: c.notNull,
        hasDefault: c.hasDefault,
      })),
    ).toEqual([
      { name: "created_at", type: "timestamp with time zone", notNull: false, hasDefault: true },
      { name: "updated_at", type: "timestamp with time zone", notNull: false, hasDefault: true },
      { name: "archived_at", type: "timestamp with time zone", notNull: false, hasDefault: false },
      { name: "stage", type: "text", notNull: false, hasDefault: false },
      { name: "score", type: "double precision", notNull: false, hasDefault: false },
      { name: "score_explanation", type: "text", notNull: false, hasDefault: false },
      { name: "spec_version", type: "integer", notNull: false, hasDefault: false },
      { name: "normalized_name", type: "text", notNull: false, hasDefault: false },
    ]);
  });

  it("makes every column nullable or defaulted, and none unique", () => {
    for (const c of columns) {
      expect(c.notNull && !c.hasDefault, c.name).toBe(false);
      expect(c.isUnique, c.name).toBe(false);
      expect(c.primary, c.name).toBe(false);
    }
  });
});
