# @hyperfixation/testing

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
