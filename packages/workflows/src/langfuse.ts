import { LangfuseSpanProcessor } from "@langfuse/otel";
import { trace, type TracerProvider } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { processGlobal } from "./process-global.js";

/** The three variables `LangfuseSpanProcessor` reads for itself; all three or nothing. */
export const LANGFUSE_ENV = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
] as const;

type LangfuseConfig = Record<(typeof LANGFUSE_ENV)[number], string>;

/**
 * Logged when the trace global already belongs to another SDK's provider — not a second call to
 * this function, which is `LangfuseConflict`. `setGlobalTracerProvider` answers false rather than
 * throwing and the diag logger that would have said so is off, so a process in this state exported
 * nothing and said nothing: how demo-two ran two live calls into an empty Langfuse.
 */
export const LANGFUSE_GLOBAL_TAKEN_MARKER =
  "hf-langfuse: another OpenTelemetry tracer provider owns the global, so nothing exports to Langfuse; initialise Sentry with `skipOpenTelemetrySetup: true`, or call registerLangfuse() in a process that has no other provider";

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
 * that flushes a provider no span ever went through. It is also why `shutdown()` hands the tracer
 * provider back (`releaseGlobals`): first-one-wins means registering after a shutdown only works if
 * the global is free to take.
 *
 * Undefined, and loud, when the global was another SDK's before this: first-one-wins holds against
 * us too, so that provider keeps every span this process creates and the processor built here would
 * never see one. Returning a registration anyway is what made that invisible — it also told
 * `startWorker()` to turn DBOS's tracing on for spans with nowhere to go.
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
  if (registeredProvider() !== provider) {
    console.error(LANGFUSE_GLOBAL_TAKEN_MARKER);
    // The processor goes with it: it holds a flush timer, and nothing will ever hand it a span.
    void provider.shutdown().catch(() => undefined);
    return undefined;
  }

  const handle: Registration = {
    async shutdown() {
      // Two callers can hold this one object, and `provider.shutdown()` ends the exporter; the
      // flag makes the second delivery the no-op it should be. Clearing the guard is the other
      // half: after a shutdown there is nothing to hand back, so a later call registers for real.
      if (handle.done) return;
      handle.done = true;
      if (state.registered?.handle === handle) state.registered = undefined;

      // Flush, then shut down, then release the global — in that order. `flushThenExit()` in
      // `start-worker.ts` reaches here on SIGTERM with a batch the process is about to lose, and
      // `shutdown()` on a processor is not itself the guarantee that the batch left.
      await provider.forceFlush();
      await provider.shutdown();
      releaseGlobals(provider);
    },
    done: false,
  };

  state.registered = { config, handle };
  return handle;
}

interface Registration extends LangfuseRegistration {
  done: boolean;
}

/**
 * Hands the tracer-provider global back, which is what makes "a process that registers after a
 * shutdown registers for real" true rather than a hope. `setGlobalTracerProvider` is first-one-wins
 * — it logs through `diag` and returns false when a provider is already set — so without this a
 * later `registerLangfuse()` builds a provider and a span processor `register()` silently drops,
 * and every span keeps going to the provider this call just shut down.
 *
 * Only when the global is still ours, so that a provider registered over ours between the two
 * calls is not taken down by our shutdown. `registerLangfuse` refuses rather than returning a
 * handle when the global was already another SDK's, so reaching here with someone else's is the
 * narrow remainder rather than the `LANGFUSE_GLOBAL_TAKEN_MARKER` case.
 *
 * That global only. `register()` also installs a context manager and a propagator, but those are
 * process-wide plumbing rather than ours to take down: the app's own `installSentryContextManager()`
 * replaces the context manager after we register, and `context.disable()` here left Sentry with no
 * async-context strategy for the rest of the process, so every forked request scope fell through to
 * the process-global default and one request's tags rode out on the next. Leaving it installed costs
 * nothing either, because a later `register()` would only install the same manager again.
 */
function releaseGlobals(provider: NodeTracerProvider): void {
  if (registeredProvider() !== provider) return;
  trace.disable();
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

/**
 * What `trace.getTracer()` resolves through. The global is always the proxy; its delegate is what
 * registration sets, and on an unregistered proxy that is the noop provider rather than ours.
 */
function registeredProvider(): TracerProvider {
  const provider = trace.getTracerProvider();
  const proxy = provider as TracerProvider & { getDelegate?: () => TracerProvider };
  return proxy.getDelegate?.() ?? provider;
}
