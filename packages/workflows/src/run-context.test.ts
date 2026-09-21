import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The mirror of `define-flow.test.ts`'s topology, and the hazard #103's audit left alone: two
 * copies of this module used to be two `AsyncLocalStorage` instances, so a `step()` reached
 * through the second saw no context and threw `OutsideRun` inside a run that had one.
 * `vi.resetModules()` is the second copy; the `Symbol.for` registry the storage now lives in is
 * the realm's and survives the reset, which is exactly what makes the storage singular in a
 * process whose module graph is not.
 */
describe("the run context", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("is visible to a second copy of this module", async () => {
    const first = await import("./run-context.js");
    vi.resetModules();
    const second = await import("./run-context.js");

    expect(second.withRunContext).not.toBe(first.withRunContext);

    const context = { runId: "run-1", attempt: 1, workflowId: "wf-1" };
    const seen = await first.withRunContext(context, async () => second.currentRun("step"));

    expect(seen).toEqual(context);
  });

  it("still refuses outside a run, in either copy", async () => {
    const first = await import("./run-context.js");
    vi.resetModules();
    const second = await import("./run-context.js");

    // Matched on the message, not the class: a reset module's classes are new identities.
    expect(() => first.currentRun("step")).toThrow(/^OutsideRun:/);
    expect(() => second.currentRun("step")).toThrow(/^OutsideRun:/);
  });

  it("does not leak a context out of the callback that set it", async () => {
    const { currentRun, withRunContext } = await import("./run-context.js");

    await withRunContext({ runId: "run-2", attempt: 3, workflowId: "wf-2" }, async () => {
      expect(currentRun("step").attempt).toBe(3);
    });

    expect(() => currentRun("step")).toThrow(/^OutsideRun:/);
  });
});
