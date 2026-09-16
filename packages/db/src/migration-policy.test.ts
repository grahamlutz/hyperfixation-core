import { describe, expect, it } from "vitest";
import { assertAppMigrationAllowed, MigrationPolicyViolation } from "./migration-policy.js";

const CREATE_FUNCTION = `
CREATE FUNCTION app_touch() RETURNS trigger AS $$
BEGIN
  UPDATE app_thing SET touched_at = now() WHERE id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`;

const CREATE_OR_REPLACE_FUNCTION = `
CREATE OR REPLACE FUNCTION app_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RETURN NEW;
END;
$$;
`;

const CREATE_PROCEDURE = `
CREATE PROCEDURE app_backfill() LANGUAGE sql AS $$
  UPDATE app_thing SET note = 'x';
$$;
`;

const DROP_COLUMN = `ALTER TABLE "app_thing" DROP COLUMN "note";`;

const ORDINARY_MIGRATION = `
CREATE TABLE "app_thing" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY NOT NULL,
  "name" text NOT NULL,
  "owner_id" text
);
--> statement-breakpoint
ALTER TABLE "app_thing" ADD COLUMN "note" text;
--> statement-breakpoint
ALTER TABLE "app_thing" ADD COLUMN "stage" text NOT NULL DEFAULT 'new';
--> statement-breakpoint
CREATE INDEX "app_thing_stage_idx" ON "app_thing" ("stage");
`;

describe("assertAppMigrationAllowed", () => {
  it("rejects CREATE FUNCTION", () => {
    expect(() => assertAppMigrationAllowed(CREATE_FUNCTION)).toThrow(MigrationPolicyViolation);
    expect(() => assertAppMigrationAllowed(CREATE_FUNCTION)).toThrow(/CREATE FUNCTION/);
  });

  it("rejects CREATE OR REPLACE FUNCTION", () => {
    expect(() => assertAppMigrationAllowed(CREATE_OR_REPLACE_FUNCTION)).toThrow(
      MigrationPolicyViolation,
    );
  });

  it("rejects CREATE PROCEDURE", () => {
    expect(() => assertAppMigrationAllowed(CREATE_PROCEDURE)).toThrow(MigrationPolicyViolation);
  });

  it("rejects DROP COLUMN", () => {
    expect(() => assertAppMigrationAllowed(DROP_COLUMN)).toThrow(MigrationPolicyViolation);
    expect(() => assertAppMigrationAllowed(DROP_COLUMN)).toThrow(/DROP COLUMN/);
  });

  it("rejects DROP TABLE", () => {
    expect(() => assertAppMigrationAllowed(`DROP TABLE "app_thing";`)).toThrow(
      MigrationPolicyViolation,
    );
  });

  it("rejects DML", () => {
    expect(() => assertAppMigrationAllowed(`UPDATE "app_thing" SET note = 'x';`)).toThrow(
      MigrationPolicyViolation,
    );
  });

  it("rejects a unique index", () => {
    expect(() =>
      assertAppMigrationAllowed(`CREATE UNIQUE INDEX "i" ON "app_thing" ("name");`),
    ).toThrow(MigrationPolicyViolation);
  });

  it("rejects ADD COLUMN NOT NULL without a default", () => {
    expect(() =>
      assertAppMigrationAllowed(`ALTER TABLE "app_thing" ADD COLUMN "n" text NOT NULL;`),
    ).toThrow(MigrationPolicyViolation);
  });

  it("rejects SET NOT NULL", () => {
    expect(() =>
      assertAppMigrationAllowed(`ALTER TABLE "app_thing" ALTER COLUMN "name" SET NOT NULL;`),
    ).toThrow(MigrationPolicyViolation);
  });

  it("accepts an ordinary migration", () => {
    expect(() => assertAppMigrationAllowed(ORDINARY_MIGRATION)).not.toThrow();
  });

  it("accepts DROP NOT NULL", () => {
    expect(() =>
      assertAppMigrationAllowed(`ALTER TABLE "app_thing" ALTER COLUMN "name" DROP NOT NULL;`),
    ).not.toThrow();
  });

  it("accepts CREATE EXTENSION IF NOT EXISTS", () => {
    expect(() =>
      assertAppMigrationAllowed(`CREATE EXTENSION IF NOT EXISTS "pg_trgm";`),
    ).not.toThrow();
  });
});
