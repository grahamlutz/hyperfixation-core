import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { MockLanguageModel } from "@hyperfixation/testing";
import { generateText, jsonSchema, Output } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixtureMissing, UnknownModel } from "./errors.js";
import { createFixtureModel, type FixtureFile } from "./fixture-model.js";
import { createProviders } from "./providers.js";

const JOIN = { runId: "r", key: "k", promptName: "draft", promptHash: "ph" };

describe("the fixture model", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hf-fixtures-"));
  });

  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  async function write(promptName: string, file: FixtureFile): Promise<void> {
    await writeFile(path.join(dir, `${promptName}.json`), JSON.stringify(file));
  }

  function call(
    model: LanguageModelV4,
    userText: string,
    promptName = "draft",
  ): ReturnType<typeof generateText> {
    return generateText({
      model,
      system: "be brief",
      prompt: userText,
      maxRetries: 0,
      providerOptions: { hyperfixation: { ...JOIN, promptName } },
    });
  }

  it("picks the first entry whose `when` matches the user text, else the default entry", async () => {
    await write("draft", {
      responses: [
        { when: { userTextIncludes: "acme roofing" }, text: "acme answer" },
        { when: { userTextIncludes: "beta" }, text: "beta answer" },
        { text: "default answer" },
      ],
    });
    const model = createFixtureModel({ dir, modelId: "claude-sonnet-4-5" });

    expect((await call(model, "a quote for Acme Roofing please")).text).toBe("acme answer");
    expect((await call(model, "beta industries")).text).toBe("beta answer");
    expect((await call(model, "nobody in particular")).text).toBe("default answer");
  });

  it("resolves the file from the promptName on the call", async () => {
    await write("summarize", { responses: [{ text: "a summary" }] });
    const model = createFixtureModel({ dir, modelId: "claude-sonnet-4-5" });

    expect((await call(model, "anything", "summarize")).text).toBe("a summary");
  });

  it("answers a `json` entry through the schema path", async () => {
    await write("extract", { responses: [{ json: { name: "Acme", margin: 0.3 } }] });
    const model = createFixtureModel({ dir, modelId: "claude-sonnet-4-5" });

    const result = await generateText({
      model,
      system: "be brief",
      prompt: "acme",
      maxRetries: 0,
      providerOptions: { hyperfixation: { ...JOIN, promptName: "extract" } },
      output: Output.object({
        schema: jsonSchema<{ name: string; margin: number }>({
          type: "object",
          properties: { name: { type: "string" }, margin: { type: "number" } },
          required: ["name", "margin"],
        }),
        name: "extract",
      }),
    });

    expect(result.output).toEqual({ name: "Acme", margin: 0.3 });
  });

  it("bills zero tokens unless the entry says otherwise", async () => {
    await write("free", { responses: [{ text: "free" }, { text: "priced" }] });
    const model = createFixtureModel({ dir, modelId: "claude-sonnet-4-5" });

    const zero = await call(model, "anything", "free");
    expect(zero.usage.inputTokens).toBe(0);
    expect(zero.usage.outputTokens).toBe(0);

    await write("priced", { responses: [{ text: "priced", inputTokens: 7, outputTokens: 11 }] });
    const priced = await call(model, "anything", "priced");
    expect(priced.usage.inputTokens).toBe(7);
    expect(priced.usage.outputTokens).toBe(11);
  });

  it("throws FixtureMissing rather than inventing an answer", async () => {
    const model = createFixtureModel({ dir, modelId: "claude-sonnet-4-5" });

    await expect(call(model, "anything", "no-such-file")).rejects.toBeInstanceOf(FixtureMissing);

    await write("no-match", { responses: [{ when: { userTextIncludes: "acme" }, text: "a" }] });
    await expect(call(model, "beta", "no-match")).rejects.toBeInstanceOf(FixtureMissing);

    // A call with no join on it cannot name a file; that is a wiring bug, not a default.
    await expect(
      generateText({ model, system: "s", prompt: "p", maxRetries: 0 }),
    ).rejects.toBeInstanceOf(FixtureMissing);
  });
});

describe("the registry's fixture fallback", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hf-fixtures-registry-"));
    await writeFile(path.join(dir, "draft.json"), JSON.stringify({ responses: [{ text: "ok" }] }));
  });

  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it("serves fixtures when no provider key at all is configured", () => {
    const providers = createProviders({ fixtures: { dir } });

    expect(providers.model("claude-sonnet-4-5").provider).toBe("hyperfixation-fixture");
    // A name with no cost row is still servable; the answer's zero tokens bill nothing.
    expect(providers.model("not-in-the-table").provider).toBe("hyperfixation-fixture");
    expect(providers.cost("not-in-the-table").actual({ inputTokens: 0, outputTokens: 0 })).toBe(0);
    // A priced name keeps its real row, so the estimate the gate reserves is the real one.
    expect(providers.cost("claude-sonnet-4-5").provider).toBe("anthropic");
  });

  it("refuses a missing key when another provider is configured", () => {
    const providers = createProviders({ anthropic: { apiKey: "not-a-key" }, fixtures: { dir } });

    expect(providers.model("claude-sonnet-4-5").provider).toBe("anthropic.messages");
    expect(() => providers.model("gpt-5")).toThrow(UnknownModel);
  });

  it("lets an explicit models entry still win", () => {
    const mock = new MockLanguageModel();
    const providers = createProviders({ fixtures: { dir }, models: { "claude-sonnet-4-5": mock } });

    expect(providers.model("claude-sonnet-4-5")).toBe(mock);
  });

});

/**
 * The join `llm.run` puts on every call has to survive the SDK untouched, or the fixture model
 * cannot tell which file to read.
 */
describe("providerOptions", () => {
  it("reaches doGenerate unaltered on both the plain and the schema path", async () => {
    const plain = new MockLanguageModel({ responses: [{ text: "hi" }] });
    await generateText({
      model: plain,
      system: "s",
      prompt: "p",
      maxRetries: 0,
      providerOptions: { hyperfixation: JOIN },
    });
    expect(plain.calls[0]!.providerOptions).toEqual({ hyperfixation: JOIN });

    const schema = new MockLanguageModel({ responses: [{ text: '{"a":1}' }] });
    await generateText({
      model: schema,
      system: "s",
      prompt: "p",
      maxRetries: 0,
      providerOptions: { hyperfixation: JOIN },
      output: Output.object({
        schema: jsonSchema<{ a: number }>({
          type: "object",
          properties: { a: { type: "number" } },
          required: ["a"],
        }),
        name: "k",
      }),
    });
    expect(schema.calls[0]!.providerOptions).toEqual({ hyperfixation: JOIN });
  });
});
