import { describe, expect, it } from "vitest";
import { createRegistry, DuplicateRegistration, UnknownRegistration } from "./registry.js";

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
