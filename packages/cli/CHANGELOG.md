# @hyperfixation/cli

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
