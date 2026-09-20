# @hyperfixation/workflows

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
