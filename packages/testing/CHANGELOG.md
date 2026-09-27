# @hyperfixation/testing

## 0.1.10

### Patch Changes

- Updated dependencies [e9dae6f]
  - @hyperfixation/db@0.1.10

## 0.1.9

### Patch Changes

- Updated dependencies [5662f8d]
  - @hyperfixation/db@0.1.9

## 0.1.8

### Patch Changes

- Updated dependencies [7715754]
  - @hyperfixation/db@0.1.8

## 0.1.7

### Patch Changes

- ecd68f2: `TestDatabase.drop()` now waits for the database's own backends to disconnect before the
  `DROP DATABASE … WITH (FORCE)`, instead of terminating whatever it finds. Awaiting every
  `pool.end()` in an `afterAll` was never that guarantee: `pg`'s `pool.end()` resolves as soon as
  it has *called* `client.end()` on each pooled connection, not when their sockets have closed, so
  the drop raced connections that were still winding down. A client killed mid-`end()` still
  carries `pg-pool`'s `idleListener`, which re-emits the `57P01` on a pool nothing is listening to
  — an uncaught exception that failed a task after all of its tests had passed. The wait is
  bounded, so a genuinely leaked connection is still forced out rather than hanging the teardown.
- Updated dependencies [ecd68f2]
- Updated dependencies [06695ea]
  - @hyperfixation/db@0.1.7

## 0.1.6

### Patch Changes

- @hyperfixation/db@0.1.6

## 0.1.5

### Patch Changes

- @hyperfixation/db@0.1.5

## 0.1.4

### Patch Changes

- @hyperfixation/db@0.1.4

## 0.1.3

### Patch Changes

- @hyperfixation/db@0.1.3

## 0.1.2

### Patch Changes

- c6b4b62: New `waitForWorkflowStatus(pool, workflowId, status, options)`, the `dbos.workflow_status`
  sibling of `waitForRun`. Every `hf_run` status the flow wrapper writes is committed from inside
  the workflow body, so DBOS records the attempt's terminal status only after the body returns: a
  test that reads the DBOS row once, the moment `hf_run` settles, is reading it inside that gap.
  Like `waitForRun` it prints the last row it saw when it times out, as `WorkflowNeverMatched`.
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
