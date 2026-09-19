import { expect, it, vi } from "vitest";
import { createProviders } from "./providers.js";

/** Its own file: the once-per-process flag is module state, and a fresh file is a fresh one. */
it("warns once about serving fixtures, however many registries ask", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    createProviders({ fixtures: { dir: "/nowhere" } }).model("claude-sonnet-4-5");
    createProviders({ fixtures: { dir: "/nowhere" } }).model("gpt-5");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("serving LLM calls from fixtures in /nowhere");
  } finally {
    warn.mockRestore();
  }
});
