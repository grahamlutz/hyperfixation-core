# @hyperfixation/workflows

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
