import { doublePrecision, integer, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Spread into an app's record table. Every column is nullable or DB-defaulted and none is
 * unique, so adding the mixin to an existing table is an allowed app migration. The trigram
 * index on `normalized_name` is the app's to declare (E003 fails boot without it).
 */
export const hfRecordColumns = () => ({
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
  stage: text("stage"),
  score: doublePrecision("score"),
  scoreExplanation: text("score_explanation"),
  specVersion: integer("spec_version"),
  normalizedName: text("normalized_name"),
});
