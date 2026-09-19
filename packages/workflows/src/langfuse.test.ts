import { trace, type TracerProvider } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it } from "vitest";
import { LANGFUSE_ENV, registerLangfuse, type LangfuseRegistration } from "./langfuse.js";

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
});

/**
 * `trace.getTracerProvider()` is always the proxy; its delegate is what registration sets, and
 * `getDelegate()` on an unregistered proxy answers the noop provider, not a `NodeTracerProvider`.
 */
function delegateOf(provider: TracerProvider): TracerProvider | undefined {
  const delegate = (provider as { getDelegate?: () => TracerProvider }).getDelegate?.();
  return delegate instanceof NodeTracerProvider ? delegate : undefined;
}
