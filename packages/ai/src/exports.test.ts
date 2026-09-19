import { describe, expect, it } from "vitest";
import type { JSONSchema7, LlmRunOptions } from "./index.js";

/**
 * What a template hoists beside its prompt: the constant is typed from the package's own
 * re-export rather than derived from `LlmRunOptions["schema"]`, which is the whole point of
 * publishing the type. Its being assignable to `schema` is the assertion; the body below only
 * keeps vitest from calling the file empty.
 */
const DRAFT_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: { body: { type: "string" } },
  required: ["body"],
};

const OPTIONS: LlmRunOptions = {
  key: "draft:1",
  model: "claude-sonnet-4-5",
  prompt: "draft",
  input: { name: "Acme Roofing" },
  schema: DRAFT_SCHEMA,
};

describe("the package's public types", () => {
  it("types a hoisted schema constant through the re-exported JSONSchema7", () => {
    expect(OPTIONS.schema).toBe(DRAFT_SCHEMA);
  });
});
