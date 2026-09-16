import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { CassetteExhausted, MockLanguageModel } from "./mock-language-model.js";

describe("MockLanguageModel", () => {
  it("answers the AI SDK from the cassette, in order, over no network", async () => {
    const model = new MockLanguageModel({
      responses: [
        { text: "first", inputTokens: 11, outputTokens: 3 },
        { text: "second" },
      ],
    });

    const first = await generateText({ model, prompt: "one" });
    const second = await generateText({ model, prompt: "two" });

    expect([first.text, second.text]).toEqual(["first", "second"]);
    expect(first.usage.inputTokens).toBe(11);
    expect(first.usage.outputTokens).toBe(3);
  });

  it("records every call it was made", async () => {
    const model = new MockLanguageModel({ responses: [{ text: "ok" }] });

    await generateText({ model, prompt: "what colour", temperature: 0 });

    expect(model.callCount).toBe(1);
    expect(model.calls[0]?.temperature).toBe(0);
    expect(JSON.stringify(model.calls[0]?.prompt)).toContain("what colour");
  });

  it("takes a response arranged after it was constructed", async () => {
    const model = new MockLanguageModel();
    model.enqueue({ text: "late" });

    expect((await generateText({ model, prompt: "?", maxRetries: 0 })).text).toBe("late");
  });

  it("throws the arranged error instead of answering", async () => {
    const model = new MockLanguageModel({ responses: [{ error: new Error("provider 503") }] });

    await expect(generateText({ model, prompt: "?", maxRetries: 0 })).rejects.toThrow("provider 503");
    expect(model.callCount).toBe(1);
  });

  it("refuses a call the test never arranged rather than inventing one", async () => {
    const model = new MockLanguageModel({ responses: [{ text: "only one" }] });
    await generateText({ model, prompt: "?", maxRetries: 0 });

    await expect(generateText({ model, prompt: "?", maxRetries: 0 })).rejects.toThrow(CassetteExhausted);
    expect(model.callCount).toBe(2);
  });
});
