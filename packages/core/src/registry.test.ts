import type { Flow } from "@hyperfixation/workflows";
import { describe, expect, it } from "vitest";
import { defineApp } from "./define-app.js";
import { createRegistry, DuplicateRegistration, UnknownRegistration } from "./registry.js";
import { defineSchedule } from "./schedules.js";
import { defineSpec } from "./specs.js";

describe("a registry", () => {
  it("refuses a second registration under a name it already holds", () => {
    const registry = createRegistry<{ name: string; which: number }>("scorer");
    registry.register({ name: "buy-box", which: 1 });

    expect(() => registry.register({ name: "buy-box", which: 2 })).toThrow(DuplicateRegistration);
    // The first registration stands: a duplicate is refused, never merged or overwritten.
    expect(registry.require("buy-box").which).toBe(1);
  });

  it("names the kind and everything registered when asked for one that is not", () => {
    const registry = createRegistry<{ name: string }>("channel");
    registry.register({ name: "email" });

    const thrown = (): unknown => registry.require("letter");
    expect(thrown).toThrow(UnknownRegistration);
    expect(thrown).toThrow(/no channel named "letter"/);
    expect(thrown).toThrow(/registers email/);
  });

  it("keys on whatever the registration calls its name", () => {
    const registry = createRegistry<{ table: string; recordType: string }>(
      "record type",
      (entry) => entry.recordType,
    );
    registry.register({ table: "businesses", recordType: "business" });

    expect(registry.names()).toEqual(["business"]);
    expect(registry.get("business")?.table).toBe("businesses");
    expect(() => registry.register({ table: "other", recordType: "business" })).toThrow(
      DuplicateRegistration,
    );
  });

  it("reports what it holds", () => {
    const registry = createRegistry<{ name: string }>("source");
    registry.register({ name: "a" });
    registry.register({ name: "b" });

    expect(registry.size).toBe(2);
    expect(registry.has("a")).toBe(true);
    expect(registry.has("c")).toBe(false);
    expect(registry.get("c")).toBeUndefined();
    expect(registry.all().map((entry) => entry.name)).toEqual(["a", "b"]);
  });
});

/** The kinds C1 adds; every one of them is a `createRegistry`, errors and all. */
describe("the spec, page and schedule registries", () => {
  const flow: Flow<never, unknown> = {
    name: "score",
    queue: "llm",
    workflow: () => Promise.resolve(undefined),
  };
  const app = (): ReturnType<typeof defineApp> =>
    defineApp({
      name: "demo",
      flows: [flow],
      specs: [defineSpec({ name: "buy-box", version: 1, criteria: {} })],
      pages: [{ path: "/w", title: "Home" }],
      schedules: [defineSchedule({ name: "nightly", flow, every: 60_000 })],
    });

  it("refuses a duplicate spec, page or schedule", () => {
    const registered = app();

    expect(() =>
      registered.specs.register(defineSpec({ name: "buy-box", version: 2, criteria: {} })),
    ).toThrow(DuplicateRegistration);
    // Keyed by path, so two pages may share a title and never a route.
    expect(() => registered.pages.register({ path: "/w", title: "Something else" })).toThrow(
      DuplicateRegistration,
    );
    expect(() =>
      registered.schedules.register(defineSchedule({ name: "nightly", flow, every: 1 })),
    ).toThrow(DuplicateRegistration);
  });

  it("names the kind when asked for one that is not registered", () => {
    const registered = app();

    expect(() => registered.specs.require("margin")).toThrow(/no spec named "margin"/);
    expect(() => registered.pages.require("/w/records")).toThrow(/no page named "\/w\/records"/);
    expect(() => registered.schedules.require("hourly")).toThrow(/no schedule named "hourly"/);
    expect(() => registered.schedules.require("hourly")).toThrow(UnknownRegistration);
  });

  it("keys a page by its path", () => {
    expect(app().pages.names()).toEqual(["/w"]);
    expect(app().pages.get("/w")?.title).toBe("Home");
  });
});
