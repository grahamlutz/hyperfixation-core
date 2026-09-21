import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { processGlobal } from "./process-global.js";

/** The three variables `LangfuseSpanProcessor` reads for itself; all three or nothing. */
export const LANGFUSE_ENV = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
] as const;

type LangfuseConfig = Record<(typeof LANGFUSE_ENV)[number], string>;

export interface LangfuseRegistration {
  /** Flushes the batch. Called from the SIGTERM handler before the process exits. */
  shutdown(): Promise<void>;
}

export class LangfuseConflict extends Error {
  /** Both are `describeConfig()` lines: the three variable names, the secret as a length. */
  constructor(first: string, second: string) {
    super(
      "LangfuseConflict: registerLangfuse was already called with a different configuration — " +
        `first ${first}, now ${second}. A process exports to one ` +
        "Langfuse project: the tracer provider goes on the OpenTelemetry global, which keeps the " +
        "first and ignores the second, so honouring this call would be a lie.",
    );
    this.name = "LangfuseConflict";
  }
}

/**
 * Registers the process-wide tracer provider Langfuse exports through, or nothing when the keys
 * are absent — in which case `trace.getTracer()` stays the no-op proxy and every span the AI
 * SDK and DBOS would create costs nothing.
 *
 * `register()` also installs the async-hooks context manager, which is what lets a `gen_ai` span
 * inherit the DBOS step span's trace id; DBOS's own installer then sees a working context and
 * leaves ours alone. Exported so the web's `instrumentation.ts` registers the same way.
 *
 * Idempotent process-wide, not per module copy: a second call for the same three values is one
 * registration reaching here twice and gets the first one's handle back. A second provider would
 * mean a second `LangfuseSpanProcessor` — two exporters on the same spans — behind a `shutdown()`
 * that flushes a provider no span ever went through.
 */
export function registerLangfuse(
  env: NodeJS.ProcessEnv = process.env,
): LangfuseRegistration | undefined {
  if (LANGFUSE_ENV.some((name) => (env[name] ?? "") === "")) return undefined;

  const config = configOf(env);
  const state = processGlobal<{ registered?: { config: LangfuseConfig; handle: Registration } }>(
    "@hyperfixation/workflows#langfuse",
    () => ({}),
  );

  const existing = state.registered;
  if (existing !== undefined) {
    if (!sameConfig(existing.config, config)) {
      throw new LangfuseConflict(describeConfig(existing.config), describeConfig(config));
    }
    return existing.handle;
  }

  const provider = new NodeTracerProvider({ spanProcessors: [new LangfuseSpanProcessor()] });
  provider.register();

  const handle: Registration = {
    async shutdown() {
      // Two callers can hold this one object, and `provider.shutdown()` ends the exporter; the
      // flag makes the second delivery the no-op it should be. Clearing the guard is the other
      // half: after a shutdown there is nothing to hand back, so a later call registers for real.
      if (handle.done) return;
      handle.done = true;
      if (state.registered?.handle === handle) state.registered = undefined;
      await provider.shutdown();
    },
    done: false,
  };

  state.registered = { config, handle };
  return handle;
}

interface Registration extends LangfuseRegistration {
  done: boolean;
}

function configOf(env: NodeJS.ProcessEnv): LangfuseConfig {
  return {
    LANGFUSE_PUBLIC_KEY: env.LANGFUSE_PUBLIC_KEY ?? "",
    LANGFUSE_SECRET_KEY: env.LANGFUSE_SECRET_KEY ?? "",
    LANGFUSE_BASE_URL: env.LANGFUSE_BASE_URL ?? "",
  };
}

function sameConfig(first: LangfuseConfig, second: LangfuseConfig): boolean {
  return LANGFUSE_ENV.every((name) => first[name] === second[name]);
}

/** The secret is the one of the three that cannot go in an error message; its length can. */
function describeConfig(config: LangfuseConfig): string {
  return (
    `LANGFUSE_BASE_URL=${JSON.stringify(config.LANGFUSE_BASE_URL)}, ` +
    `LANGFUSE_PUBLIC_KEY=${JSON.stringify(config.LANGFUSE_PUBLIC_KEY)}, ` +
    `LANGFUSE_SECRET_KEY=<${String(config.LANGFUSE_SECRET_KEY.length)} chars>`
  );
}
