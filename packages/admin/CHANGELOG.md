# @hyperfixation/admin

## 0.1.2

### Patch Changes

- Updated dependencies [1c5152b]
  - @hyperfixation/auth@0.1.2
  - @hyperfixation/core@0.1.2
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
  - @hyperfixation/core@0.1.1
  - @hyperfixation/auth@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies
  - @hyperfixation/db@0.1.0
  - @hyperfixation/auth@0.1.0
  - @hyperfixation/core@0.1.0
