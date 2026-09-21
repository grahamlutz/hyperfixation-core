import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LANGFUSE_ENV, registerLangfuse, type LangfuseRegistration } from "./langfuse.js";
import { endGenAiSpan, startFakeOtlp, type FakeOtlp } from "./test-support/fake-otlp.js";

/**
 * The export half, against a localhost OTLP endpoint, in a process whose Sentry is initialised
 * first — the worker's order, where `src/boot-sentry.ts` runs before `@hyperfixation/workflows`
 * is even evaluated. `skipOpenTelemetrySetup` is what leaves the OTel global free for this to
 * register into; the file beside this one is the same process without it.
 *
 * Its own file because the OTel globals are process-wide and first-one-wins: two Sentry shapes
 * cannot be asserted in one.
 */
const PUBLIC_KEY = "pk-lf-fake";
const SECRET_KEY = "sk-lf-fake";
const DSN = "https://ffffffffffffffffffffffffffffffff@o0.ingest.sentry.io/0";

let otlp: FakeOtlp;
let registration: LangfuseRegistration | undefined;

beforeAll(async () => {
  otlp = await startFakeOtlp();
});

afterAll(async () => {
  await registration?.shutdown();
  for (const name of LANGFUSE_ENV) delete process.env[name];
  await otlp.close();
});

describe("registerLangfuse beside a Sentry that skips the OpenTelemetry setup", () => {
  // First, while the keys are still unset and the global still unregistered: a process without a
  // Langfuse destination creates no exporter and posts nothing anywhere.
  it("exports nothing when the keys are absent", () => {
    expect(registerLangfuse({})).toBeUndefined();

    endGenAiSpan();

    expect(otlp.requests).toEqual([]);
  });

  it("exports a gen_ai span when the flush runs", async () => {
    Object.assign(process.env, {
      LANGFUSE_PUBLIC_KEY: PUBLIC_KEY,
      LANGFUSE_SECRET_KEY: SECRET_KEY,
      LANGFUSE_BASE_URL: otlp.baseUrl,
    });
    const Sentry = await import("@sentry/node");
    Sentry.init({ dsn: DSN, tracesSampleRate: 0, skipOpenTelemetrySetup: true });

    registration = registerLangfuse();
    expect(registration).toBeDefined();

    endGenAiSpan();
    // The one the SIGTERM handler's `flushThenExit()` calls; nothing has been posted before it.
    expect(otlp.requests).toEqual([]);
    await registration?.shutdown();
    registration = undefined;

    expect(otlp.requests).toHaveLength(1);
    const [request] = otlp.requests;
    expect(request?.path).toBe("/api/public/otel/v1/traces");
    expect(request?.byteLength).toBeGreaterThan(0);
    expect(request?.headers.authorization).toBe(
      `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`,
    );
    expect(request?.headers["x-langfuse-public-key"]).toBe(PUBLIC_KEY);
  });
});
