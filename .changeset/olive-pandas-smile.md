---
"@hyperfixation/workflows": patch
"@hyperfixation/core": patch
---

Hold the three process-wide registries on the process instead of on a module. A Next production
build instantiates the app's module graph once per module layer — the rsc page layer and the
server-action layer of one request, in one process (#103) — so module scope is not process scope
for anything an app's own files reach. `registerLangfuse` now returns the first registration to a
second identical call rather than building a second `NodeTracerProvider` and span processor the
OpenTelemetry global ignores, and throws the new `LangfuseConflict` — naming both configurations,
never the secret key — when the second call names a different Langfuse project. `run-context.ts`'s
`AsyncLocalStorage` and the worker runtime `startWorker()` sets both live behind `Symbol.for`
keys, so a `step()` reached through a second module copy sees the run it is in instead of
`OutsideRun`. `defineApp`'s `attach()` keys the control plane by app name on the process, so the
layer that did not make the `attach()` call is attached too and a server action in it no longer
gets `AppNotAttached`. `LangfuseConflict` is the only added export; nothing already exported
changed shape.
