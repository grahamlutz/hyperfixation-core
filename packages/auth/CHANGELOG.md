# @hyperfixation/auth

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

- 1c5152b: `evaluateAccess` reads `banExpires`, so a ban that has lapsed stops 404ing the user out of
  `/admin` and `/w`. Banned now means what the notifier's SQL already meant — `banned IS TRUE AND
  (ban_expires IS NULL OR ban_expires > now())` — and `AccessRequest.now` injects the clock.
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
