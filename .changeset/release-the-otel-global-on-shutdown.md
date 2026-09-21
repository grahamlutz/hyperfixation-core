---
"@hyperfixation/workflows": patch
"@hyperfixation/core": patch
---

Make three claims #123 made actually true. `registerLangfuse`'s `shutdown()` now hands the
OpenTelemetry tracer provider back — and only while the registered provider is still the one it
built — so "a process that registers after a shutdown registers for
real" holds instead of the second `register()` being the silent no-op `setGlobalTracerProvider` is
when a provider is already set, which left the new provider and its span processor orphaned while
every span went on to the shut-down one. It also `forceFlush`es before shutting the provider down,
which is the batch `start-worker.ts`'s SIGTERM path is there to save. The worker-runtime process
global moves to a versioned key (`@hyperfixation/workflows#workerRuntime.v1`): `WorkerRuntime` is a
structural record read field by field, so two versions of this package in one process now each get
`WorkerNotStarted` rather than one being handed a shape it does not know — the run context's
`AsyncLocalStorage` and `@hyperfixation/core`'s control-plane map stay unversioned, because sharing
those across versions is the point of putting them on the process. No exported name changed.
