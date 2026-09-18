import { hfUser, hfSession } from "@hyperfixation/db";
import { describe, expect, it } from "vitest";
import { resourceFromTable, UnknownAdminField } from "./resource.js";

describe("deriving a resource from Drizzle metadata", () => {
  const users = resourceFromTable(hfUser, { name: "users", list: ["email", "role"] });

  it("takes the table name and every field from the table, not from a hand-written copy", () => {
    expect(users.table).toBe("hf_user");
    // The whole point of generating: this list is whatever the schema currently declares. A
    // column added to `hf_user` appears here without anyone editing this package.
    expect(users.fields.map((field) => field.name)).toEqual([
      "id",
      "name",
      "email",
      "emailVerified",
      "image",
      "createdAt",
      "updatedAt",
      "role",
      "banned",
      "banReason",
      "banExpires",
    ]);
  });

  it("carries each field's SQL column, so a UI never has to guess the snake_case form", () => {
    const byName = Object.fromEntries(users.fields.map((field) => [field.name, field.column]));
    expect(byName.emailVerified).toBe("email_verified");
    expect(byName.banReason).toBe("ban_reason");
  });

  it("reads nullability, defaults, primary key and uniqueness off the metadata", () => {
    const field = (name: string) => users.fields.find((entry) => entry.name === name);

    expect(field("id")).toMatchObject({ primaryKey: true, nullable: false, hasDefault: false });
    expect(field("email")).toMatchObject({ unique: true, nullable: false });
    expect(field("image")).toMatchObject({ nullable: true, primaryKey: false, unique: false });
    expect(field("banned")).toMatchObject({ nullable: true, hasDefault: true });
    expect(users.primaryKey).toEqual(["id"]);
  });

  it("maps Drizzle's data types onto the handful of kinds a UI renders", () => {
    const kind = (name: string) => users.fields.find((entry) => entry.name === name)?.kind;

    expect(kind("email")).toBe("string");
    expect(kind("emailVerified")).toBe("boolean");
    expect(kind("createdAt")).toBe("date");
  });

  it("labels every field from its name, so a new column arrives already labelled", () => {
    const label = (name: string) => users.fields.find((entry) => entry.name === name)?.label;

    expect(label("email")).toBe("Email");
    expect(label("emailVerified")).toBe("Email verified");
    expect(label("banReason")).toBe("Ban reason");
  });

  it("shows every field on the detail view unless the caller narrows it", () => {
    expect(users.view).toEqual(users.fields.map((field) => field.name));
    expect(users.list).toEqual(["email", "role"]);
  });

  it("works against any hf_* table, not just hf_user", () => {
    const sessions = resourceFromTable(hfSession, { name: "sessions", list: ["token"] });
    expect(sessions.table).toBe("hf_session");
    expect(sessions.fields.find((field) => field.name === "factor")?.column).toBe("factor");
  });
});

describe("a declared field list checked against the metadata", () => {
  it("refuses a list or view field the table does not have", () => {
    // A declared subset is the one hand-written part of a resource, so it is the one part that
    // can rot when a column is renamed. It fails at construction rather than at render.
    expect(() => resourceFromTable(hfUser, { name: "users", list: ["emial"] })).toThrow(
      UnknownAdminField,
    );
    expect(() =>
      resourceFromTable(hfUser, { name: "users", list: ["email"], view: ["nope"] }),
    ).toThrow(UnknownAdminField);
  });

  it("names the resource, the field and what the table does have", () => {
    try {
      resourceFromTable(hfUser, { name: "users", list: ["emial"] });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownAdminField);
      const failure = error as UnknownAdminField;
      expect(failure.resource).toBe("users");
      expect(failure.field).toBe("emial");
      expect(failure.known).toContain("email");
      expect(failure.message).toContain("emial");
    }
  });
});
