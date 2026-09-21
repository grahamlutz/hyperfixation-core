---
"@hyperfixation/workflows": patch
---

Say when Langfuse registered nothing. Every OpenTelemetry global is first-one-wins, and
`@sentry/node` v10's `init()` puts its own tracer provider on the trace global, so in a process
whose Sentry boots first — the template's worker and its `instrumentation.ts` both do —
`registerLangfuse()`'s `provider.register()` was refused, the `LangfuseSpanProcessor` never saw a
span, and a registration was returned anyway: the app exported nothing, said nothing, and told
`startWorker()` to turn DBOS's tracing on for spans with nowhere to go. That is how demo-two made
two live `claude-haiku-4-5` calls with working Langfuse keys and left zero observations.
`registerLangfuse()` now checks that the global resolves to its own provider, and on a conflict
logs `LANGFUSE_GLOBAL_TAKEN_MARKER` and returns undefined instead.
