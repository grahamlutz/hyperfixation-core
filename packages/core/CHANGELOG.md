# @hyperfixation/core

## 0.1.9

### Patch Changes

- 636f38e: Hold the three process-wide registries on the process instead of on a module. A Next production
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
- c301efe: Make three claims #123 made actually true. `registerLangfuse`'s `shutdown()` now hands the
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
- Updated dependencies [7ebee8b]
- Updated dependencies [2de023d]
- Updated dependencies [636f38e]
- Updated dependencies [5662f8d]
- Updated dependencies [c301efe]
  - @hyperfixation/workflows@0.1.9
  - @hyperfixation/db@0.1.9

## 0.1.8

### Patch Changes

- 7715754: Bill a period at the ledger's own scale. `hf_budget_period.spent_usd` was `numeric(12,4)` while
  `hf_llm_call.cost_usd` is `numeric(12,6)`, and every settle is `spent_usd = spent_usd + cost_usd`,
  so each sub-cent call rounded the running total and the error grew with the number of calls — the
  first two real provider calls on the X1 box reported a `$0.000007` drift and a `degraded` status.
  Migration `0009_budget_spent_scale` widens the column to `numeric(12,6)` and repairs the rounding
  already stored. `/api/status` and `reconcile()` now subtract in Postgres at that scale, so
  `spentUsd`, `ledgerUsd` and `driftUsd` all print six decimals and a settled period drifts by
  exactly `0.000000`.
- Updated dependencies [7715754]
  - @hyperfixation/db@0.1.8
  - @hyperfixation/workflows@0.1.8

## 0.1.7

### Patch Changes

- Updated dependencies [ecd68f2]
- Updated dependencies [06695ea]
  - @hyperfixation/db@0.1.7
  - @hyperfixation/workflows@0.1.7

## 0.1.6

### Patch Changes

- @hyperfixation/db@0.1.6
  - @hyperfixation/workflows@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [123aeab]
  - @hyperfixation/workflows@0.1.5
  - @hyperfixation/db@0.1.5

## 0.1.4

### Patch Changes

- @hyperfixation/db@0.1.4
  - @hyperfixation/workflows@0.1.4

## 0.1.3

### Patch Changes

- @hyperfixation/db@0.1.3
  - @hyperfixation/workflows@0.1.3

## 0.1.2

### Patch Changes

- @hyperfixation/workflows@0.1.2
  - @hyperfixation/db@0.1.2

## 0.1.1

### Patch Changes

- `/api/status` now carries `llm.mode`, which `reportProvidersMode(pool)` writes at worker boot
  (migration 0008), and `hf doctor` warns when an app is serving fixture drafts. The CLI gained the
  cloud `hf new` path, `hf doctor` and `hf restore-check`, with the SSH runner and provisioning
  behind them; a child that exits before reading its stdin no longer fails a run with `EPIPE`, and
  `hf_score` names the spec it scored.
- Updated dependencies
  - @hyperfixation/db@0.1.1
  - @hyperfixation/workflows@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies
  - @hyperfixation/db@0.1.0
  - @hyperfixation/workflows@0.1.0
