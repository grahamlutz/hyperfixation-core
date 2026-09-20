# @hyperfixation/cli

## 0.1.2

### Patch Changes

- 811b8a0: The cloud `langfuse` step no longer needs an organization-scoped key, which is a Langfuse paid-plan feature: `HF_LANGFUSE_ORG_KEY` is optional, the new `HF_LANGFUSE_PUBLIC_KEY`/`HF_LANGFUSE_SECRET_KEY` pair is recorded as the app's keys without any Langfuse request, and with neither the step warns, adds a closing-checklist line and `hf new` omits `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` from the Coolify environment rather than sending them empty.
- ab264e3: The cloud `repo` step no longer aborts a run when the token may not list GitHub App installations: a 401/403/404 from `GET /user/installations` now records the step and warns, naming each `HF_GITHUB_APP_SLUGS` entry and its install URL in the warning and in the closing checklist.
- 801bffd: `spawnCollecting` now surfaces a non-EPIPE stdin error through the exec promise instead of swallowing it.
- 720ad4e: `hf doctor` reads an older app's `/api/status` without crashing: a field the deployed core does
  not carry — `llm` before 0.1.1, and anything newer — reads as unknown instead of throwing.
  `hf new` in the cloud now names every missing operator config key before the first request, not
  one failed step at a time.
- e013630: The cluster tunnel discovers its target instead of assuming the box's loopback: Coolify publishes
  no port for its Postgres, so when `127.0.0.1:5432` carries no query the runner asks
  `docker inspect` for the container's address on the `coolify` network and forwards to that, with
  the box as the hop. `hf new`, `hf doctor`'s E006 and `hf restore-check` all take the discovered
  address, `pg_restore` included. Two new optional config keys: `HF_DB_CONTAINER`, which replaces
  the pair of container names derived from `HF_COOLIFY_POSTGRES_UUID`, and `HF_PG_ADMIN_USER`, for a
  cluster whose superuser is not `postgres`.
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
