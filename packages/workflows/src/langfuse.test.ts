import { context, createContextKey, trace, type TracerProvider } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LANGFUSE_ENV,
  LangfuseConflict,
  registerLangfuse,
  type LangfuseRegistration,
} from "./langfuse.js";

const FAKE_KEYS = {
  LANGFUSE_PUBLIC_KEY: "pk-lf-fake",
  LANGFUSE_SECRET_KEY: "sk-lf-fake",
  LANGFUSE_BASE_URL: "http://langfuse.invalid",
};

/**
 * `startWorker()` itself cannot be launched in-process (see `test-support/worker-fixture.ts`), so
 * what is asserted here is the half that is process-wide: what `registerLangfuse` does or does
 * not leave on the OTel global. Nothing exports — no span is ever created.
 */
describe("registerLangfuse", () => {
  let registration: LangfuseRegistration | undefined;

  // No `trace.disable()` here. Releasing the OTel global is `shutdown()`'s job — production
  // never calls `trace.disable()`, so a test that did would be proving its own tidying up
  // rather than the claim that a later `registerLangfuse()` can register for real.
  afterEach(async () => {
    await registration?.shutdown();
    registration = undefined;
    vi.restoreAllMocks();
    for (const name of LANGFUSE_ENV) delete process.env[name];
  });

  it("registers nothing when the keys are absent", () => {
    expect(registerLangfuse({})).toBeUndefined();
    expect(delegateOf(trace.getTracerProvider())).toBeUndefined();
  });

  it("registers nothing when one of the three is empty", () => {
    expect(registerLangfuse({ ...FAKE_KEYS, LANGFUSE_BASE_URL: "" })).toBeUndefined();
    expect(delegateOf(trace.getTracerProvider())).toBeUndefined();
  });

  it("registers a node tracer provider when all three are set", () => {
    Object.assign(process.env, FAKE_KEYS);

    registration = registerLangfuse();

    expect(registration).toBeDefined();
    expect(delegateOf(trace.getTracerProvider())).toBeInstanceOf(NodeTracerProvider);
  });

  it("hands the first registration back to a second identical call", () => {
    Object.assign(process.env, FAKE_KEYS);

    registration = registerLangfuse();

    // A second provider would be a second `LangfuseSpanProcessor` exporting the same spans,
    // behind a `shutdown()` for a provider OTel kept nothing pointed at.
    expect(registerLangfuse()).toBe(registration);
  });

  it("is idempotent across two copies of this module", async () => {
    Object.assign(process.env, FAKE_KEYS);
    const first = await import("./langfuse.js");
    registration = first.registerLangfuse();

    vi.resetModules();
    const second = await import("./langfuse.js");
    expect(second.registerLangfuse).not.toBe(first.registerLangfuse);

    expect(second.registerLangfuse()).toBe(registration);
    vi.resetModules();
  });

  it("refuses a second call that names a different Langfuse project", () => {
    Object.assign(process.env, FAKE_KEYS);
    registration = registerLangfuse();

    const other = { ...FAKE_KEYS, LANGFUSE_BASE_URL: "http://other.invalid" };
    expect(() => registerLangfuse(other)).toThrow(LangfuseConflict);
    // Both are named, so the message says which two configurations are fighting.
    expect(() => registerLangfuse(other)).toThrow(/langfuse\.invalid.*other\.invalid/s);
    // And the secret never reaches the message.
    expect(() => registerLangfuse(other)).not.toThrow(/sk-lf-fake/);
  });

  it("registers again after a shutdown, with nothing else releasing the global", async () => {
    Object.assign(process.env, FAKE_KEYS);
    const first = registerLangfuse();
    const firstProvider = delegateOf(trace.getTracerProvider());
    await first?.shutdown();

    // The whole point of the case: `setGlobalTracerProvider` is first-one-wins, so if `shutdown()`
    // had not handed the global back, `register()` below would be a silent no-op and every span
    // would keep going to the provider above — which is shut down.
    expect(delegateOf(trace.getTracerProvider())).toBeUndefined();

    registration = registerLangfuse();

    expect(registration).not.toBe(first);
    const secondProvider = delegateOf(trace.getTracerProvider());
    expect(secondProvider).toBeInstanceOf(NodeTracerProvider);
    expect(secondProvider).not.toBe(firstProvider);
  });

  it("flushes the batch before it shuts the provider down and before it lets the global go", async () => {
    Object.assign(process.env, FAKE_KEYS);
    // `forceFlush` and `shutdown` live on `BasicTracerProvider`, one link up the chain from
    // `NodeTracerProvider`, whose own prototype carries nothing but `register`.
    const base = Object.getPrototypeOf(NodeTracerProvider.prototype) as Record<
      string,
      () => Promise<void>
    >;
    const forceFlush = vi.spyOn(base, "forceFlush");
    const shutdown = vi.spyOn(base, "shutdown");

    const handle = registerLangfuse();
    await handle?.shutdown();

    // The SIGTERM path (`flushThenExit`) reaches here with the last batch of a redeploy in it.
    expect(forceFlush).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(forceFlush.mock.invocationCallOrder[0]!).toBeLessThan(
      shutdown.mock.invocationCallOrder[0]!,
    );
    expect(delegateOf(trace.getTracerProvider())).toBeUndefined();
  });

  it("leaves the context manager installed, because the app's Sentry one replaces ours", async () => {
    Object.assign(process.env, FAKE_KEYS);
    const probe = createContextKey("probe");

    await registerLangfuse()?.shutdown();

    // `context.disable()` here would swap the async-context manager for the noop one, which
    // answers `ROOT_CONTEXT` inside a `with()`. The template's `installSentryContextManager()`
    // owns this global by the time a worker shuts down, and Sentry reads a forked request scope
    // off it: with no strategy every fork falls through to the process-global default scope, so
    // one request's tags ride out on the next.
    const seen = context.with(context.active().setValue(probe, "set"), () =>
      context.active().getValue(probe),
    );
    expect(seen).toBe("set");
  });
});

/**
 * `trace.getTracerProvider()` is always the proxy; its delegate is what registration sets, and
 * `getDelegate()` on an unregistered proxy answers the noop provider, not a `NodeTracerProvider`.
 */
function delegateOf(provider: TracerProvider): TracerProvider | undefined {
  const delegate = (provider as { getDelegate?: () => TracerProvider }).getDelegate?.();
  return delegate instanceof NodeTracerProvider ? delegate : undefined;
}
