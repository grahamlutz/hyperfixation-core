import { trace, type TracerProvider } from "@opentelemetry/api";
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

  afterEach(async () => {
    await registration?.shutdown();
    registration = undefined;
    trace.disable();
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

  it("registers again after a shutdown", async () => {
    Object.assign(process.env, FAKE_KEYS);
    const first = registerLangfuse();
    await first?.shutdown();
    trace.disable();

    registration = registerLangfuse();

    expect(registration).not.toBe(first);
    expect(delegateOf(trace.getTracerProvider())).toBeInstanceOf(NodeTracerProvider);
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
