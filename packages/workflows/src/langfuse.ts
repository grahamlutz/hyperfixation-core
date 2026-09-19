import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

/** The three variables `LangfuseSpanProcessor` reads for itself; all three or nothing. */
export const LANGFUSE_ENV = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
] as const;

export interface LangfuseRegistration {
  /** Flushes the batch. Called from the SIGTERM handler before the process exits. */
  shutdown(): Promise<void>;
}

/**
 * Registers the process-wide tracer provider Langfuse exports through, or nothing when the keys
 * are absent — in which case `trace.getTracer()` stays the no-op proxy and every span the AI
 * SDK and DBOS would create costs nothing.
 *
 * `register()` also installs the async-hooks context manager, which is what lets a `gen_ai` span
 * inherit the DBOS step span's trace id; DBOS's own installer then sees a working context and
 * leaves ours alone. Exported so the web's `instrumentation.ts` registers the same way.
 */
export function registerLangfuse(
  env: NodeJS.ProcessEnv = process.env,
): LangfuseRegistration | undefined {
  if (LANGFUSE_ENV.some((name) => (env[name] ?? "") === "")) return undefined;

  const provider = new NodeTracerProvider({ spanProcessors: [new LangfuseSpanProcessor()] });
  provider.register();
  return { shutdown: () => provider.shutdown() };
}
