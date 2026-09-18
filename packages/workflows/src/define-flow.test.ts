import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `defineFlow`'s registration half, and the one thing about it a bundler can break.
 *
 * A module-level `DBOS.registerWorkflow` assumes it runs once per process. That holds for
 * `worker.ts`, which Node evaluates directly, and does **not** hold for the web: Next splits an
 * app's server code per route, so `src/flows/*.ts` is instantiated once per chunk that reaches
 * it, while `@dbos-inc/dbos-sdk` is external and therefore one object — and the second
 * instantiation is refused by DBOS with "Operation is already registered", after which every
 * route that touches the app 500s. It was observed on a real `hf new` app the moment a second
 * route imported `src/hyperfixation.ts`, in `next dev` and in the standalone build alike.
 *
 * `vi.resetModules()` reproduces exactly that shape: a fresh copy of this package's own modules
 * against the same externalised DBOS. It is also why the refusals are matched on their message
 * and not with `toThrow(DuplicateFlow)` — a reset module's classes are new identities.
 */
describe("defineFlow", () => {
  const originalProcess = process.env.HF_PROCESS;

  afterEach(() => {
    vi.resetModules();
    if (originalProcess === undefined) delete process.env.HF_PROCESS;
    else process.env.HF_PROCESS = originalProcess;
  });

  it("refuses two flows of one name inside a single evaluation", async () => {
    const { defineFlow } = await import("./define-flow.js");
    defineFlow("duplicate-within-one-graph", async () => undefined, { queue: "resolve" });

    expect(() =>
      defineFlow("duplicate-within-one-graph", async () => undefined, { queue: "resolve" }),
    ).toThrow(/^DuplicateFlow:/);
  });

  it("refuses a queue no worker registers", async () => {
    const { defineFlow } = await import("./define-flow.js");

    expect(() =>
      defineFlow("unknown-queue", async () => undefined, {
        queue: "nowhere" as "resolve",
      }),
    ).toThrow(/^UnknownQueue:/);
  });

  it("survives a second module instance in the web, which is what a bundled route produces", async () => {
    process.env.HF_PROCESS = "web";
    const first = await import("./define-flow.js");
    first.defineFlow("web-two-chunks", async () => undefined, { queue: "resolve" });

    vi.resetModules();
    const second = await import("./define-flow.js");

    expect(() =>
      second.defineFlow("web-two-chunks", async () => undefined, { queue: "resolve" }),
    ).not.toThrow();
    // And the flow is still in the registry the enqueue path reads, because `runs.start` needs
    // its queue name whether or not DBOS has ever heard of it.
    expect(second.definedFlows().get("web-two-chunks")?.queue).toBe("resolve");
  });

  it("registers with DBOS in the worker, where a second instance would be a real duplicate", async () => {
    process.env.HF_PROCESS = "worker";
    const first = await import("./define-flow.js");
    first.defineFlow("worker-registers", async () => undefined, { queue: "resolve" });

    vi.resetModules();
    const second = await import("./define-flow.js");

    // DBOS is external and therefore the same object across both instances; it is the one
    // holding the registration, which is the whole reason this is worker-only.
    expect(() =>
      second.defineFlow("worker-registers", async () => undefined, { queue: "resolve" }),
    ).toThrow();
  });
});
