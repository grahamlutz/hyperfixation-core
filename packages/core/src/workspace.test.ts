import { describe, expect, it } from "vitest";
import { defineApp, type App } from "./define-app.js";
import { InvalidDefinition } from "./registry.js";
import type { RecordDefinition } from "./records.js";
import { approvalPath, draftFields } from "./workspace.js";

const BUSINESS: RecordDefinition = {
  table: "business",
  recordType: "business",
  title: "Businesses",
  stages: [
    { name: "new", title: "New" },
    { name: "diligence", title: "Diligence" },
  ],
};

/** No `title`: the nav falls back to `recordType`. */
const NOTE: RecordDefinition = { table: "demo_note", recordType: "demo_note" };

function workspaceApp(): App {
  return defineApp({
    name: "demo",
    records: [BUSINESS, NOTE],
    pages: [
      { path: "/w/reports", title: "Reports", nav: true },
      { path: "/w/reports/monthly", title: "Monthly" },
    ],
  });
}

describe("record definitions", () => {
  it("refuses a duplicate stage, naming the record type", () => {
    const definition: RecordDefinition = {
      table: "business",
      recordType: "business",
      stages: [
        { name: "new", title: "New" },
        { name: "new", title: "Also new" },
      ],
    };

    expect(() => defineApp({ name: "demo", records: [definition] })).toThrow(InvalidDefinition);
    expect(() => defineApp({ name: "demo", records: [definition] })).toThrow(/"business".*"new"/);
  });

  it("takes a bare record table, and keys the registry by record type", () => {
    const app = defineApp({ name: "demo", records: [{ table: "demo_note", recordType: "note" }] });

    expect(app.records.types.names()).toEqual(["note"]);
    expect(app.records.types.require("note").stages).toBeUndefined();
  });
});

describe("workspace.route", () => {
  const app = workspaceApp();

  it.each([
    ["/w", { kind: "home" }],
    ["/", { kind: "home" }],
    ["/w/approvals", { kind: "inbox" }],
    ["/w/approvals/12", { kind: "approval", id: 12 }],
    ["/w/business", { kind: "board", record: BUSINESS }],
    ["/w/business/41", { kind: "record", record: BUSINESS, id: "41" }],
    ["/w/reports", { kind: "page", page: { path: "/w/reports", title: "Reports", nav: true } }],
    [
      "/w/reports/monthly",
      { kind: "page", page: { path: "/w/reports/monthly", title: "Monthly" } },
    ],
    ["/w/approvals/latest", undefined],
    ["/w/approvals/0", undefined],
    ["/w/approvals/12/edit", undefined],
    ["/w/widget", undefined],
    ["/w/business/41/edit", undefined],
  ])("resolves %s", (path, expected) => {
    expect(app.workspace.route(path)).toEqual(expected);
  });

  it("takes a catch-all's segments as the path below the mount", () => {
    expect(app.workspace.route([])).toEqual({ kind: "home" });
    expect(app.workspace.route(undefined)).toEqual({ kind: "home" });
    expect(app.workspace.route(["approvals", "12"])).toEqual({ kind: "approval", id: 12 });
    expect(app.workspace.route(["business", "41"])).toEqual({
      kind: "record",
      record: BUSINESS,
      id: "41",
    });
    expect(app.workspace.route(["reports"])).toEqual({
      kind: "page",
      page: { path: "/w/reports", title: "Reports", nav: true },
    });
  });

  it("prefers a record type to a page registered at the same path", () => {
    const app = defineApp({
      name: "demo",
      records: [BUSINESS],
      pages: [{ path: "/w/business", title: "Not this one" }],
    });

    expect(app.workspace.route("/w/business")).toEqual({ kind: "board", record: BUSINESS });
  });
});

describe("workspace.nav", () => {
  it("lists home, the inbox, every record type, then the pages that asked for it", () => {
    expect(workspaceApp().workspace.nav()).toEqual([
      { path: "/w", title: "Home" },
      { path: "/w/approvals", title: "Inbox" },
      { path: "/w/business", title: "Businesses" },
      { path: "/w/demo_note", title: "demo_note" },
      { path: "/w/reports", title: "Reports" },
    ]);
  });
});

describe("approvalPath", () => {
  it("is the inbox's detail path", () => {
    expect(approvalPath(7)).toBe("/w/approvals/7");
    expect(workspaceApp().workspace.route(approvalPath(7))).toEqual({ kind: "approval", id: 7 });
  });
});

describe("draftFields", () => {
  it("flattens nested objects and arrays, and labels each leaf", () => {
    expect(
      draftFields({
        subject: "Q3 update",
        contactEmail: "a@example.com",
        body: { greeting: "Hi", paragraphs: ["one", "two"] },
      }),
    ).toEqual([
      { path: "subject", segments: ["subject"], label: "Subject", value: "Q3 update" },
      {
        path: "contactEmail",
        segments: ["contactEmail"],
        label: "Contact email",
        value: "a@example.com",
      },
      { path: "body.greeting", segments: ["body", "greeting"], label: "Greeting", value: "Hi" },
      {
        path: "body.paragraphs[0]",
        segments: ["body", "paragraphs", 0],
        label: "Paragraphs 1",
        value: "one",
      },
      {
        path: "body.paragraphs[1]",
        segments: ["body", "paragraphs", 1],
        label: "Paragraphs 2",
        value: "two",
      },
    ]);
  });

  it("gives colliding display paths distinct segments", () => {
    expect(draftFields({ "a.b": 1, a: { b: 2 } })).toEqual([
      { path: "a.b", segments: ["a.b"], label: "A.b", value: "1" },
      { path: "a.b", segments: ["a", "b"], label: "B", value: "2" },
    ]);
  });

  it("walks a literal __proto__ key like any other", () => {
    expect(draftFields(JSON.parse('{"__proto__": {"x": "own"}}'))).toEqual([
      { path: "__proto__.x", segments: ["__proto__", "x"], label: "X", value: "own" },
    ]);
  });

  it("makes every value a string, and every absence an empty one", () => {
    expect(
      draftFields({ count: 3, ratio: 0.5, urgent: false, note: null, missing: undefined }),
    ).toEqual([
      { path: "count", segments: ["count"], label: "Count", value: "3" },
      { path: "ratio", segments: ["ratio"], label: "Ratio", value: "0.5" },
      { path: "urgent", segments: ["urgent"], label: "Urgent", value: "false" },
      { path: "note", segments: ["note"], label: "Note", value: "" },
      { path: "missing", segments: ["missing"], label: "Missing", value: "" },
    ]);
  });

  it("gives a container no row of its own", () => {
    expect(draftFields({ contacts: [], meta: {} })).toEqual([]);
  });

  it("names a bare scalar draft", () => {
    expect(draftFields("just text")).toEqual([
      { path: "value", segments: [], label: "Value", value: "just text" },
    ]);
    expect(draftFields(null)).toEqual([
      { path: "value", segments: [], label: "Value", value: "" },
    ]);
  });

  it("hands markup through as the literal string it is", () => {
    expect(draftFields({ note: "<img src=x>" })).toEqual([
      { path: "note", segments: ["note"], label: "Note", value: "<img src=x>" },
    ]);
  });
});
