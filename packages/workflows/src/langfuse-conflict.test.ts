import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LANGFUSE_ENV, LANGFUSE_GLOBAL_TAKEN_MARKER, registerLangfuse } from "./langfuse.js";
import { endGenAiSpan, startFakeOtlp, type FakeOtlp } from "./test-support/fake-otlp.js";

/**
 * The same process as `langfuse-export.test.ts` with `skipOpenTelemetrySetup` left off, which is
 * how demo-two ran: `@sentry/node` v10 registers its own tracer provider on the OTel global, so
 * the provider built here is refused and every `gen_ai` span goes to Sentry's — which, at
 * `tracesSampleRate: 0`, drops it. Langfuse saw no observation for two live calls.
 */
const DSN = "https://ffffffffffffffffffffffffffffffff@o0.ingest.sentry.io/0";

let otlp: FakeOtlp;

beforeAll(async () => {
  otlp = await startFakeOtlp();
});

afterAll(async () => {
  for (const name of LANGFUSE_ENV) delete process.env[name];
  await otlp.close();
});

describe("registerLangfuse beside a Sentry that owns the OpenTelemetry global", () => {
  it("registers nothing, says so, and exports nothing", async () => {
    Object.assign(process.env, {
      LANGFUSE_PUBLIC_KEY: "pk-lf-fake",
      LANGFUSE_SECRET_KEY: "sk-lf-fake",
      LANGFUSE_BASE_URL: otlp.baseUrl,
    });
    const Sentry = await import("@sentry/node");
    Sentry.init({ dsn: DSN, tracesSampleRate: 0 });
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(registerLangfuse()).toBeUndefined();
    expect(reported).toHaveBeenCalledWith(LANGFUSE_GLOBAL_TAKEN_MARKER);
    reported.mockRestore();

    endGenAiSpan();
    // No flush to wait on: nothing was registered. The span reached Sentry's provider instead.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(otlp.requests).toEqual([]);
  });
});
