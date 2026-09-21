# @hyperfixation/workflows

## 0.1.9

### Patch Changes

- 7ebee8b: Say when Langfuse registered nothing. Every OpenTelemetry global is first-one-wins, and
  `@sentry/node` v10's `init()` puts its own tracer provider on the trace global, so in a process
  whose Sentry boots first — the template's worker and its `instrumentation.ts` both do —
  `registerLangfuse()`'s `provider.register()` was refused, the `LangfuseSpanProcessor` never saw a
  span, and a registration was returned anyway: the app exported nothing, said nothing, and told
  `startWorker()` to turn DBOS's tracing on for spans with nowhere to go. That is how demo-two made
  two live `claude-haiku-4-5` calls with working Langfuse keys and left zero observations.
  `registerLangfuse()` now checks that the global resolves to its own provider, and on a conflict
  logs `LANGFUSE_GLOBAL_TAKEN_MARKER` and returns undefined instead.
- 2de023d: Compare two definitions of a flow name by a normalised token stream instead of by `fn.toString()`,
  so `defineFlow`'s idempotency survives a real bundler. #103 made an identical re-definition return
  the flow it already defined, but "identical" meant character for character, and the two module
  layers of one route never are: `next build --webpack` compiles a route's graph once per layer and
  minifies each with its own name budget. The template's `collectDemoSource` arrives in the page
  layer and in the server-action layer differing in five tokens — three renamed import bindings, one
  renamed local, and the webpack module id of the body's own `await import(…)`, which is a *number* —
  so every definition still collided and any route loading the flows in a second layer crashed with
  `DuplicateFlow`. The comparison now normalises identifiers to positional placeholders and numeric
  literals to one placeholder, keeping property names, string, regex and template text, keywords,
  operators and the shape; both compiled layers are committed as fixtures under
  `packages/workflows/src/__fixtures__/`. Two genuinely different flows of one name — a differing
  string, statement, operator, property or option — still throw `DuplicateFlow` with the message they
  always had. `DefineFlowOptions.version` is the new optional escape hatch for the one build this
  cannot see through, a minifier that mangles property access as well as identifiers: state it and the
  bodies are not compared at all, while a second `version` of one name is still a collision. It is the
  only added API and nothing already exported changed shape.
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
- Updated dependencies [5662f8d]
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

## 0.1.7

### Patch Changes

- Updated dependencies [ecd68f2]
- Updated dependencies [06695ea]
  - @hyperfixation/db@0.1.7

## 0.1.6

### Patch Changes

- @hyperfixation/db@0.1.6

## 0.1.5

### Patch Changes

- 123aeab: `defineFlow` treats an identical re-definition as the definition it already has. The first real
  deployment died on `DuplicateFlow: a flow named "collectDemoSource" is already defined` right after
  a passkey enrolment: the page runs a `"use server"` action and then re-renders, so Next instantiates
  the app's `src/flows/*.ts` once per module layer — rsc page and server action — in one process,
  while this package is a `serverExternalPackages` external and therefore singular. The second layer's
  call reached a registry that already held the name. A second call now matches the name against the
  first definition's fingerprint — the options, key order ignored, and `fn.toString()` — and on a match
  returns the first flow's handle without a second `DBOS.registerWorkflow`. Two genuinely different
  definitions of one name still throw `DuplicateFlow` with the same message. A closed-over value that
  differs between the two module copies is invisible to the fingerprint; that is its known limit.
- @hyperfixation/db@0.1.5

## 0.1.4

### Patch Changes

- @hyperfixation/db@0.1.4

## 0.1.3

### Patch Changes

- @hyperfixation/db@0.1.3

## 0.1.2

### Patch Changes

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

## 0.1.0

### Patch Changes

- Updated dependencies
  - @hyperfixation/db@0.1.0
