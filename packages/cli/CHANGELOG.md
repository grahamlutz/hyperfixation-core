# @hyperfixation/cli

## 0.1.10

### Patch Changes

- e9dae6f: A raw-fetch cache with per-host rate limits, so a collector reads its source over HTTP without
  re-downloading it on every tick and without two workers hitting one host together.
  
  Core migration `0011_raw_fetch_cache` creates `hf_raw_fetch` — one response per
  `(url_hash, method)`, unique over the hash rather than the URL because a URL has no length bound
  and a btree entry does — and `hf_fetch_domain`, the politeness interval per host. Two
  `CREATE TABLE`s and one `CREATE UNIQUE INDEX`, nothing altered, so it is additive against N-1's
  readers and `migration-additivity.test.ts` passes unexcused.
  
  `fetch.get(ctx, { url, ttlMs?, headers? })` is called from inside a `step()` body, the shape
  `llm.run` and `actions.perform` already have. A hit inside `expires_at` returns the stored row and
  makes no request. A miss takes `pg_advisory_xact_lock(hashtext('hf-fetch:' || domain))`, waits out
  whatever the host's `min_interval_ms` still owes, fetches, and writes the row — all in one
  `ctx.tx`, because the lock is transaction-scoped and releasing it before the request is what would
  let two workers through at once. Defaults: a 24-hour TTL and one request a second per host.
  
  A body over 5 MB is refused rather than stored: `Content-Length` is checked before any transfer
  and the stream is abandoned the moment the running total passes the cap, so 6 MB never lands in
  memory. The refusal is a committed row carrying the status it refused, and a hit on it throws
  again without a request — a URL that was too big stays too big.
  
  Waiting *for* that lock is bounded by a `SET LOCAL lock_timeout` of `FETCH_LOCK_TIMEOUT_MS`, or
  twice the host's own interval where that is longer: the holder keeps the lock across a request, so
  a process killed mid-fetch would otherwise leave every other worker wanting that host queued
  behind an idle transaction until something reaped the connection.
  
  `hf doctor`'s `lock` line now decides on the count of locks carrying `hashtext('hf-worker:<app>')`
  rather than on the count of advisory locks held. It counted every one, so an app caught mid-fetch —
  a second, unrelated advisory lock in the same database — reported a false `FAIL` on a healthy app,
  and `hf doctor` gates deploys. Two locks under the worker's own key still fail.
  
  New exports, every one additive: `fetch`, `fetchGet`, `fetchDomainOf`, `urlHash`,
  `FetchTooLarge`, `RawFetch`, `FetchGetOptions`, the five `FETCH_*` statements, the three
  `*_FETCH_*` defaults, and the `hfRawFetch`/`hfFetchDomain` tables. Nothing existing is retyped,
  which is what keeps this a patch and what `api:diff` confirms.
- ba2be74: `hf doctor` gains a `readonly` line per app: the `_ro` role Metabase reads through exists, can read
  `hf_run`, can read none of `GRANT_RO_EXCLUDED_TABLES`, and was created with `CONNECTION LIMIT 4`.
  The role was provisioned and its grants applied since Phase 5, but nothing read them back — a
  `GRANT` that reached an auth table would have been invisible until someone queried the box by hand.
  
  An absent role WARNs rather than FAILs: Metabase is optional per deployment, and `hf new` creates
  the role only when a read-only password was supplied. Everything else FAILs, a readable `hf_user`
  above all — that is a reader with a route towards a staff session.
  
  The query runs over the same admin tunnel as the E006, `connections` and `lock` lines, and reads
  `has_table_privilege` by oid against `pg_class`, so a table the database does not have reads
  `absent` (its own message) instead of erroring the whole line. `readonlyGrantsSql` is exported for
  the test that runs it against a migrated database; nothing here is in the package's public API
  report.
- 026d7de: Two commands and a `hf doctor` line for the two things an app's spend and its keys had no handle
  on. `hf budget <name> --usd <n>` sets `hf_app_state.budget_usd` — the default every new period is
  created from, seeded once by `hf bootstrap` and until now never again — over the tunnel, in one
  statement that also writes the `hf_audit` row naming the operator (`app.budget_default_set`,
  `hf-cli:<$HF_OPERATOR or login name>`). The period already running is untouched: that ceiling is
  the admin form's, and moving both from here would change a month nobody asked about.
  
  `hf rotate-key <name> <VAR>` replaces one of the app's provider or channel variables —
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `SMTP_URL`, `TELEGRAM_BOT_TOKEN`,
  `TELEGRAM_WEBHOOK_SECRET`, `LOB_API_KEY`, and nothing whose rotation also needs a role password or
  a signed-out session. The new value is read from stdin rather than an argument, goes out in the one
  Coolify request that has to carry it, and is neither printed nor stored: what the state file gains
  is `keys.<VAR>.rotatedAt`, a date. A deploy follows, because Coolify holds the new value the moment
  the PATCH returns and the running containers hold the old one until they are replaced.
  
  `hf doctor` gains `keys`: one line per provider or channel variable the app's Coolify environment
  has, by name, with how long ago `hf rotate-key` last replaced it — `WARN` past 90 days, and `WARN`
  for a variable that is set with no rotation recorded, which is what a key set by hand reads as.
- Updated dependencies [e9dae6f]
  - @hyperfixation/db@0.1.10
  - @hyperfixation/core@0.1.10
  - @hyperfixation/auth@0.1.10

## 0.1.9

### Patch Changes

- Updated dependencies [636f38e]
- Updated dependencies [5662f8d]
- Updated dependencies [c301efe]
  - @hyperfixation/core@0.1.9
  - @hyperfixation/auth@0.1.9
  - @hyperfixation/db@0.1.9

## 0.1.8

### Patch Changes

- Updated dependencies [7715754]
  - @hyperfixation/db@0.1.8
  - @hyperfixation/core@0.1.8
  - @hyperfixation/auth@0.1.8

## 0.1.7

### Patch Changes

- 9f25384: `hf doctor` gains two findings per app, read over the tunnel E006 already opens. `connections`
  counts every backend belonging to an `hf_*` role against the one `max_connections` the box's apps
  share — a `WARN` past 80% of it — and shows the app's own role against its `CONNECTION LIMIT` of
  25. `lock` counts the advisory locks in the app's database and checks that exactly one is held
  under `hashtext('hf-worker:' || <app>)`, the key `acquireWorkerLock` takes: none means no live
  worker and two means two, and both are a `FAIL`. Neither needs operator config, and a query that
  refuses is a `FAIL` line rather than a dead command.
- 532f1f1: `hf new --local` now refuses a missing `--budget-usd` or `--email` up front, exactly as the
  cloud path has since Phase 3, and writes the budget to the new app's `.env` as
  `HF_BOOTSTRAP_BUDGET_USD`. The local half asked for the address at an interactive prompt and
  never asked for a budget at all, which left `hf up` to seed its own dev default — an app
  running under a cap nobody chose, and a `hf new --local` that could not be run unattended at
  all. `newApp` takes the budget as `budgetUsd` and reports it as `wroteBootstrapBudget`; the
  prompt is still there for a caller that supplies its own.
- 37ea0d2: `hf restore-check` no longer reads a running app's own churn as data loss. Against a 1.3-hour-old
  dump of `demo-app`, X1 reported 9 of 24 tables mismatched — `hf_run` 30 against 3, `hf_activity` 2
  against 0 — and the same check against a fresh dump matched all 24: every one of those tables had
  simply gained rows since the dump was taken. A committed list, `APPEND_ONLY_TABLES`, names the
  eight `hf_*` tables no code path deletes from and none updates in a way that lowers their count,
  and for those a restored count *below* the live one is now `ok (drift +N)` rather than a
  mismatch. A restored count above the live one stays a mismatch there — that is the data loss the
  command exists to catch — and every other table, including one that merely looks append-only, is
  still compared exactly. `--strict` drops the allowance and compares everything exactly.
  
  A dump older than 24 h (was 36 h) now prints a `WARN` line and, following `hf doctor`, exits 1:
  a check against stale data is not a passing check. `RestoreCheckResult` gains `strict` and
  `matched` — no table failed, which is what `lastRestoreCheckAt` is written on — alongside `ok`,
  which is now `matched` and a fresh dump; `RestoreCheckRow` gains `drift`. `RestoreVerdict` is
  unchanged: drift is not its own outcome, it is an `ok` the table prints a reason beside.
- fc7974e: `hf --version` (also `-v` and `hf version`) prints the `@hyperfixation/cli` version, read from the
  package's own `package.json` at runtime so a release cannot leave it behind. And a `hf new` that
  finds something in its way now names the absolute path and the one move that clears it, for both
  directories it cares about: the app directory, and the dot-prefixed `.<name>.hf-new` scratch beside
  it. The scratch is cleared only on a genuine resume — the state cache records the fetch's start the
  way it already records the rename's — so a first run refuses one it has no record of creating
  instead of deleting a directory that was never hf's.
- Updated dependencies [ecd68f2]
- Updated dependencies [06695ea]
  - @hyperfixation/db@0.1.7
  - @hyperfixation/auth@0.1.7
  - @hyperfixation/core@0.1.7

## 0.1.6

### Patch Changes

- 2cc0ad4: Coolify never told the app which commit it built. Its docker-compose build pack passes no
  `SOURCE_COMMIT` build arg, puts nothing in the compose environment and leaves no `.git` in the
  build context, so `HF_BUILD_SHA` was unresolved and the worker refused to start. The `deploy`
  step now writes the commit being deployed into the application's own `SOURCE_COMMIT` environment
  entry — buildtime and runtime, every entry Coolify lists under the name — before it asks for a
  deployment, and `hf new` creates applications with `is_auto_deploy_enabled: false` so a push can
  no longer deploy a commit against a stale value.
  
  New command: `hf deploy <name> [--sha <sha>]` publishes a merge to main through that same path and
  waits until `/api/status` reports the sha. `hf doctor`'s version warning now names it.
- @hyperfixation/auth@0.1.6
  - @hyperfixation/core@0.1.6
  - @hyperfixation/db@0.1.6

## 0.1.5

### Patch Changes

- 327cd64: The cloud `backup` step sends the dump off the box. It registered the schedule with `save_s3: true`
  and no `s3_storage_uuid`, which Coolify 4.3.21 accepts and then runs with `S3 storage configuration
  is missing`, keeping the only copy on the same disk as the database. The storage is now resolved
  first — the new optional `HF_COOLIFY_S3_STORAGE_UUID`, else the one `is_usable` entry
  `GET /s3-storages` lists — and sent with `save_s3: true`. With no usable storage, or more than one,
  the step registers `save_s3: false` and says so in a `WARNING:` and the closing checklist rather
  than guessing. It is also idempotent now: the database's schedules are listed and this app's is
  PATCHed through `PATCH /databases/{uuid}/backups/{scheduled_backup_uuid}`, so a rerun no longer
  leaves a second one. Both operations were merged into the vendored Coolify document from its pinned
  `v4.3.21` tag.
- e218562: `hf restore-check` runs `pg_restore` inside the Postgres container instead of on the box host.
  The host has no Postgres client tools — Coolify runs Postgres only in a container — so the real
  run exited 127 with `pg_restore: command not found`. The restore is now
  `docker exec -i <container> pg_restore --no-owner --no-comments --role=<migrator> -U <admin>
  -d <scratch>` with the host's dump streamed on stdin, since the dump is not mounted into the
  container; the container comes from the same discovery the tunnel uses (`HF_DB_CONTAINER`, or
  `HF_COOLIFY_POSTGRES_UUID`) and the admin from `HF_PG_ADMIN_USER`. Exit 127 now says what it
  means and what to check. `Runner.exec` takes an `inputFile`, which on `ssh` becomes the remote
  shell's own `<` redirection. `RestoreCheckOptions.restoreAdminUrl` and `pgRestoreArgv` are
  deprecated; `pgRestoreInContainerArgv` and `findPostgresContainer` replace them.
- @hyperfixation/core@0.1.5
  - @hyperfixation/auth@0.1.5
  - @hyperfixation/db@0.1.5

## 0.1.4

### Patch Changes

- ae3adc2: The cloud `template` step no longer adopts an app directory that already exists on a first run.
  It adopted any directory whose `package.json` named the app, so a scaffold left by an earlier
  `hf new --local` was committed and pushed as if it were this run's — and Coolify's build then
  failed on its stale `pnpm-workspace.yaml`. Adoption now needs the state cache to say the step
  began (`templateStartedAt`, written just before the rename) or finished; otherwise `hf new`
  fails with a `TemplateError` telling the operator to move the directory away.
- ff15bc4: The cloud `coolify` step creates the `production` environment when the Coolify project has none,
  through `POST /projects/{uuid}/environments` (`CoolifyClient.createEnvironment`), instead of
  failing with "the API has no endpoint that creates one" — Coolify documents that endpoint, and
  the vendored OpenAPI document now keeps its `post` operation.
- @hyperfixation/auth@0.1.4
  - @hyperfixation/core@0.1.4
  - @hyperfixation/db@0.1.4

## 0.1.3

### Patch Changes

- 9d748fa: The cloud `coolify` step gives the application its domain per compose service, which is the only
  way Coolify takes one: a `dockercompose` build pack refuses `domains` outright (422, *"Use
  docker_compose_domains instead"*), so `hf new` now sends
  `docker_compose_domains: [{ name: "web", domain: "https://<app>.<HF_BASE_DOMAIN>" }]`, `web` being
  the compose service the template publishes 3000 from (`COMPOSE_DOMAIN_SERVICE`, beside
  `COMPOSE_LOCATION`). A provider's refusal is also readable now: the response's own `message` and
  `errors` reach `ProviderError.message` for all five clients, truncated to 500 characters and with
  every credential the client holds, every value the request declared and anything shaped like a
  password blanked out first. The Coolify OpenAPI document is re-vendored at the box's own release
  tag, `v4.3.21`.
- @hyperfixation/auth@0.1.3
  - @hyperfixation/core@0.1.3
  - @hyperfixation/db@0.1.3

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
