# Hyperfixation Phase 3 — implementation order

**Date:** 2026-09-19. Derived from [hyperfixation-plan-2026-09-15.md](hyperfixation-plan-2026-09-15.md) — *Phase 3*,
*Deployment shape and budgets*, *Verification* (the manual list), Phase 0 — and v1's Phase 3 section (ten steps, state
cache, `restore-check`, `doctor`, OpenAPI-validated mocks), which is at
`~/Code/planning/workbench-plan-ts-2026-09-15.md` lines 114–124 (not in this repo). **The design is fixed; this
document only orders it.** Same marker scheme as [Phase 2's](hyperfixation-phase2-order-2026-09-18.md) (✅ Done /
✅ Done (deviated) / 🚧 In progress / ⬜ Not started).

**Written against** core `origin/main` `80b5e00` and template `origin/main` `79b3ad2`; every "exists / does not exist"
claim below was checked in the tree, not taken from the plan.

**A concern up front.** A cloud `hf new` cannot deploy anything today. `hyperfixation-template/pnpm-workspace.yaml`
overrides every `@hyperfixation/*` to `link:../hyperfixation/packages/*` (39 `link:` entries in `pnpm-lock.yaml`),
`npm view @hyperfixation/core` 404s, and the `Dockerfile`'s `deps` stage copies only `package.json` and
`pnpm-lock.yaml` before `pnpm install --frozen-lockfile` — inside Coolify's build context there is no sibling checkout,
so the image build fails before `next build`. The plan puts publishing in Phase 4; the template's own comments
(`pnpm-workspace.yaml`, `ci.yml:390`, `package.json` `//dev`) assign it to Phase 3. This is open question 1 and
chunk 0.

## Where Phase 3 starts from

| Piece | Exists | Phase 3 adds |
|---|---|---|
| `hf new` (`packages/cli/src/new.ts`) | Local copy from a sibling checkout, placeholder substitution, `.env` from `.env.example`; **`local: false` throws** `"provisioning … is Phase 3"` | The remote template source and the ten cloud steps |
| `hf migrate --skip-roles` | The cloud path is already spelled (`migrate.ts:42`) | Nothing |
| `provisionRoles` (`packages/db/src/roles.ts`) | Cloud role creation: migrator (no limit), application (25), optional `_ro` (4), default privileges `FOR ROLE <migrator>` | Being called by something; `CREATE DATABASE` (it assumes the database exists) |
| `hf_grant_ro` (`grant-ro.ts`) | Migrator's last step; skips when the `_ro` role is absent | The role's creation and Metabase's checklist entry |
| `/api/status` (`core/src/status.ts`) | `applicationVersion`, `coreVersion`, health, queues, periods, drift, anomalies | Nothing — `hf doctor` reads it as is |
| `Dockerfile`, `docker-compose.prod.yml`, `docker-entrypoint.sh` | `ARG SOURCE_COMMIT` → `HF_BUILD_SHA` with a `git rev-parse` fallback; `mem_limit`s; `stop_grace_period: 90s`; `compose-envs.test.ts` pins `REQUIRED_ENV` | **Has never been built**: template CI runs only `docker compose config`; `node:25-alpine` while CI and `engines` say 22 |
| Sentry | `SENTRY_DSN` in `REQUIRED_ENV`; `instrumentation.ts` still has the Sentry `TODO` (T3 registered Langfuse only) | The web and worker init |
| `hf doctor`, `hf restore-check`, state cache, SSH runner, any Coolify/Cloudflare/Sentry/Langfuse/GitHub client, msw, OpenAPI docs | **None** (`COMMANDS` is `new migrate bootstrap status-token check gen dev up`; `cli/package.json` depends on `pg` only) | All of it |
| Phase 0 box and accounts | Evidence: `~/Code/hyperfixation-secrets/` holds Coolify, Hetzner S3, Postgres roles, Langfuse, Sentry and bot-key files dated 2026-09-16 | Nothing (not re-verified here) |
| `downstream.txt` in core | Does not exist | See open question 5 |

## Corrections this pass produced

1. **Publish before deploy** (the concern above). Chunk 0 is a *manual* first publish — no Phase 4 machinery.
2. **`restore-check` "reports through the write-token status endpoint"** (v1) has no endpoint to report through:
   `/api/status` POSTs only `pause` and `resume`. It prints, and records `lastRestoreCheckAt` in the state cache, which
   is what `hf doctor` reads. No new column, no new route.
3. **"Connection count stays under budget"** in the Phase 3 exit inherits Phase 2's finding: `pg.Pool` closes idle
   clients after 10 s, so it is *bounded* (peak < 24, no drift), never flat.
4. **The document bucket** (v1 step 5) has no consumer until Phase 6 (`hf_document`) and no `REQUIRED_ENV` name.
   Open question 3 recommends deferring it.

## Infra: what blocks, what stubs

| Needs the real box | Why |
|---|---|
| Coolify's `SOURCE_COMMIT`, `mem_limit` under Coolify, DNS and TLS, a phone passkey (`APP_URL` must be a real https origin — the RP id) | Only the box has them |
| `docker stop` timing mid-run, `pg_locks` at exit, `docker stats` | Docker on a box with a live run |
| The first-of-month period row | The calendar |

| Automatable | Harness |
|---|---|
| Every provider request | `msw` handlers plus `openapi-request-validator` against vendored OpenAPI documents (trimmed to the paths used, schemas copied verbatim) |
| Role/database provisioning, `restore-check`'s restore and count | The per-test Postgres from `@hyperfixation/testing`; `pg_dump -Fc` of a migrated test database |
| SSH | A `Runner` interface (`exec(cmd)`, `tunnel(port)`); tests inject one that runs locally and records commands |
| Image build, prod compose up, redeploy across a step change | Docker on `ubuntu-latest` in template CI (D1, D3, D4) |

---

## Chunk 0 — First publish, template consumes npm (core + template, one head, first) — ⬜ Not started

**D0 (core):** `pnpm changeset` (one fixed-group entry), `pnpm changeset version` → `0.1.0`,
`pnpm -r build && pnpm -r publish --access public` by hand from a clean clone (the API Extractor ordering lesson
applies to the build too). No release workflow, no `--provenance`, no `api-diff.test.ts`: those stay Phase 4.
**T0 (template):** delete `pnpm-workspace.yaml`; `^0.0.0` → `^0.1.0` in `package.json`; drop `--webpack` from `dev` and
CI's `next build`; delete the core checkout/build steps in `ci.yml`; regenerate the lockfile; `Dockerfile` base →
`node:22-alpine`.

**Done:** template CI green with no `hyperfixation` checkout; `grep -c "link:" pnpm-lock.yaml` = 0;
`hf new demo-app --local && hf up` in a fresh directory still passes `pnpm test`.

> After chunk 0, tracks D and E are independent (template versus `packages/cli`).

## Track D — the deploy shape (template)

### D1 — The image builds and names its version — ⬜ Not started

Template CI job `image`: `docker build --build-arg SOURCE_COMMIT=$GITHUB_SHA`, then
`docker run --rm <img> node -e 'process.exit(process.env.HF_BUILD_SHA===process.argv[1]?0:1)' $GITHUB_SHA`; a second
build **without** the arg proves the entrypoint fallback (`HF_BUILD_SHA` length ≥ 7). Also `pnpm build` (no
`--webpack`) prerenders.

**Done:** both `docker run` assertions green in CI.

### D2 — Sentry in both processes — ⬜ Not started

`@sentry/nextjs` in `instrumentation.ts` (replacing the TODO) and `@sentry/node` at the top of `worker.ts`, both
no-ops when `SENTRY_DSN` is empty. Depends on nothing.

**Done:** `tests/instrumentation.test.ts` — DSN empty → `Sentry.getClient()` undefined; dummy DSN → defined, no
network; `next build` still prerenders with the DSN empty.

### D3 — The prod stack comes up locally (after D1) — ⬜ Not started

`tests/e2e/prod-compose.e2e.ts`: dev compose's Postgres, `provisionRoles` + `CREATE DATABASE` via the test's admin URL,
then `docker compose -f docker-compose.prod.yml up -d --build` with `SOURCE_COMMIT` set; assert `migrate` exited 0,
`GET /api/status` is 401 without and 200 with the read token (provisioned through `hf status-token`),
`applicationVersion === SOURCE_COMMIT`, the worker logs `LAUNCHED_MARKER`; `docker compose stop worker` exits 0 in
< 5 s when idle. Note: the Dockerfile's `USER node` needs the app role's `DATABASE_URL`, not the compose superuser.

**Done:** the file green in template CI's `image` job.

### D4 — Redeploy across a step change, in CI (after D3) — ⬜ Not started

The automated half of the plan's first manual item. Same harness: start `draftDemoOutreach` until an approval is
`pending`; patch `src/flows/draft-demo-outreach.ts` to insert a keyed `activity.record` step before `waitForApproval`;
rebuild with a new `SOURCE_COMMIT`; `docker compose up -d` (recreates all three); decide through `workspace.decide` on
the harness pool; assert `hf_run.attempt = 2`, `current_workflow_id = '<run>:2'`, run `done`,
`/api/status.applicationVersion` is the new sha, one `hf_action_log` row `ok`.

**Done:** green twice in CI; wall clock recorded in this doc (two image builds — expect 4–8 min).

## Track E — the `hf` cloud path (`packages/cli`)

### E1 — Config, state cache, provider clients, the OpenAPI harness — ⬜ Not started

Operator config read from `~/.config/hf/config.json` (0600) with env override, keys exact: `HF_COOLIFY_URL`,
`HF_COOLIFY_TOKEN`, `HF_COOLIFY_SERVER_UUID`, `HF_COOLIFY_GITHUB_APP_UUID`, `HF_COOLIFY_POSTGRES_UUID`, `HF_SSH_HOST`,
`HF_CLOUDFLARE_TOKEN`, `HF_CLOUDFLARE_ZONE_ID`, `HF_BASE_DOMAIN`, `HF_GITHUB_TOKEN`, `HF_GITHUB_OWNER`,
`HF_SENTRY_TOKEN`, `HF_SENTRY_ORG`, `HF_LANGFUSE_URL`, `HF_LANGFUSE_ORG_KEY`, `HF_BOX_IP`, `HF_SMTP_URL`,
`HF_EMAIL_FROM`. Per-app state `~/.config/hf/state/<name>.json` (0600):
`{ steps: Record<StepName, { doneAt }>, repo, coolify: { projectUuid, appUuid }, database: { migratorPassword, applicationPassword, readonlyPassword }, sentryDsn, langfuse: { publicKey, secretKey }, statusTokens: { read, write }, lastRestoreCheckAt?, lastDeployedSha? }`.
Five thin `fetch` clients (Coolify, Cloudflare, GitHub, Sentry, Langfuse), each method one endpoint. Vendored OpenAPI
docs under `packages/cli/openapi/`; a vitest setup that fails any mocked request whose verb, path or body does not
validate.

**Done:** `pnpm --filter @hyperfixation/cli test providers` — every client method validates; a fixture handler with
the wrong verb fails; a state file written at 0644 is refused and rewritten 0600.

### E2 — SSH runner, database and roles (after E1) — ⬜ Not started

`Runner` = `ssh` child process; `tunnel()` = `ssh -N -L <port>:127.0.0.1:5432` to the Coolify Postgres container's
published-on-localhost port (Phase 0 left it unexposed publicly — verify it listens on the box's loopback; else
`docker exec psql`). Then `CREATE DATABASE hf_<app>`, `CREATE EXTENSION vector, pg_trgm`,
`provisionRoles(adminUrl, { readonlyPassword })`. A cold re-run (no state file) rotates passwords, as v1 says.

**Done:** `roles.test.ts` extended against the test Postgres with a local `Runner`: three roles with limits
`null/25/4`; re-run is a no-op; a cold run changes the application password and the old one no longer connects.

### E3 — `hf new <name>` in the cloud (after E2) — ⬜ Not started

The ten steps, resumable by state. Order: copy template (`giget gh:grahamlutz/hyperfixation-template` when `--from`
is absent and `--local` is not passed) → `pnpm install`, initial commit → GitHub private repo + push (bot secrets
**not** installed — nothing in the template's workflows needs one; instead assert both GitHub Apps are installed on
the repo) → E2 → backup registration (Coolify; see risk 3) → Sentry project → Langfuse project → Cloudflare
`A <app>.<HF_BASE_DOMAIN>` → Coolify project + application (docker-compose build pack,
`connect_to_docker_network: true`, domain) + bulk envs = exactly `REQUIRED_ENV` minus `HF_PROCESS`/`HF_BUILD_SHA`
(compose supplies those) + `hf status-token` through the tunnel (tokens into state) + `hf bootstrap --budget-usd` (no
`DEV_BUDGET_USD` in the cloud; `--budget-usd` required) → deploy, poll the deployment, poll `/api/status` with the
read token until `applicationVersion` matches the pushed sha → print the checklist (Google redirect URI; third-party
keys pasted into Coolify **and** added to `REQUIRED_ENV`/both compose blocks; Metabase connection string for the `_ro`
role; merge bump PRs only when green; the phone passkey step).

**Done:** `new.test.ts` cloud cases under msw and a recording `Runner`: (a) a full run issues the expected requests in
order and writes every state key; (b) a second run issues zero `POST`s; (c) a failure injected at Cloudflare, then a
rerun, resumes at Cloudflare with no earlier `POST`; (d) `--local` is byte-for-byte Phase 1's behaviour.

### E4 — `hf doctor` (after E2; ∥ E5) — ⬜ Not started

Per app in state: `GET /api/status` (health, `applicationVersion`, `runs.running`, both periods), the repo's `main` sha
from GitHub, E006 via the tunnel as `postgres` with `SET ROLE hf_<app>`, `lastRestoreCheckAt` older than 7 days, open
PRs on branch `core-bump/*` with their check status. Exit 1 on any warning.

**Done:** `doctor.test.ts` — version mismatch, E006 false, stale restore check, degraded health each produce their
line and exit 1; all clear exits 0.

### E5 — `hf restore-check <name>` (after E2; ∥ E4) — ⬜ Not started

Over SSH as `postgres`: newest `hf_<app>` dump (see risk 3 for where), `CREATE DATABASE hf_<app>_restore_check` +
extensions, `pg_restore --no-owner --role=hf_<app>_migrator`, `count(*)` of every `hf_*` table and every table with
`normalized_name`, the same counts on the live database, print a table, drop the scratch database, write
`lastRestoreCheckAt`. The Hetzner S3 key, if needed, is read from operator config and never written to any app.

**Done:** `restore-check.test.ts` — a `pg_dump -Fc` of a migrated test database with seeded rows restores with
matching counts and exit 0; a dump taken before a seed reports the differing table and exits 1; the scratch database
is gone afterwards.

## Exit — X1, the real box (manual; records into this doc) — ⬜ Not started

`hf new demo-app` from a laptop with only `~/.config/hf/config.json` populated. Then the manual list below, each with
its evidence line pasted here.

---

## Parallelism

| Track | Repo | Can start | Must land by |
|---|---|---|---|
| **0** (D0 + T0) | core, template | now | everything |
| **D** (D1–D4) | template | chunk 0 | X1 needs D1–D3; D4 can trail X1 |
| **E** (E1–E5) | core `packages/cli` | chunk 0 (E1 needs nothing from chunk 0 — it can start today) | X1 |

E1 ∥ D1 ∥ D2; E2 → E3; E4 ∥ E5 after E2; D3 → D4. **Chunk 0 wanted: yes**, because D3, D4 and X1 all build the image.

**Merge hot spots.** `packages/cli/etc/cli.api.md` (every E chunk; regenerate from a clean clone, as Phase 2
learned); `packages/cli/src/index.ts` and `cli.ts` (`COMMANDS`/`USAGE` — E3, E4, E5 all add a command: land E4/E5's
`cli.ts` lines in one small PR first, or accept one rebase); `packages/cli/package.json` (E1 adds `msw`, `giget`, the
validator); template `package.json` and `pnpm-lock.yaml` (0, D2); template `ci.yml` (0, D1, D3, D4 — make D1 the
only PR that adds the `image` job and have D3 and D4 add steps to it); `planning/*.md` and `README.md`'s roadmap row
(every PR that records a note — batch notes per track).

## Manual versus automated

| Manual (why) | Evidence to record |
|---|---|
| `SOURCE_COMMIT` under Coolify (unverified in the plan) | `/api/status.applicationVersion` equals the deployed commit; if the fallback fired, the `hf-build:` line in the build log |
| Phone passkey enrolment and a batch approval (Crystal's browser; needs a real https origin) | Screenshot; `hf_passkey` row; `decided_by` her id |
| Deploy a step-inserting commit while an approval is pending (plan's Done-means 1) — D4 automates the mechanism, only the box proves Coolify's sequence | `attempt = 2`, new sha on `/api/status` |
| `docker stop` mid-run: `docker kill -s TERM <worker>` during a resolve run | `docker inspect` `FinishedAt` − signal time ≤ drain + 1 s; `pg_locks` shows the advisory lock gone at that instant |
| `docker stats` memory limits under Coolify | web ≤ 512 MB, worker ≤ 768 MB, `mem_limit` visible in `docker inspect` |
| 30-minute `pg_stat_activity` soak on the box | peak < 24, no drift (bounded, not flat) |
| E006 as the app role after the first deploy | both `t` |
| First-of-month period row | `spent_usd = 0`, previous untouched, drift 0 |

## Exit bar, as tests

1. `pnpm --filter @hyperfixation/cli test` green: `providers`, `roles` (cloud), `new` (cloud a–d), `doctor`,
   `restore-check`.
2. Template CI green with the `image` job: D1's two `docker run` assertions, `prod-compose.e2e.ts`,
   `redeploy.e2e.ts` (D4).
3. `pnpm -w typecheck lint test api-extractor` green in core (baseline 91 files / 596 tests at `4c1cb4a`; record the
   new count).
4. On the box: `hf new demo-app` exits 0 printing the checklist; `hf doctor` exits 0; `hf restore-check demo-app`
   exits 0 with matching counts; the manual table filled in.

## Gate case → chunk map

| Case | First passes at | Lives in |
|---|---|---|
| lockfile has no `link:`; template CI without a core checkout | 0 | template `ci.yml` |
| `HF_BUILD_SHA` from the build arg and from the fallback | D1 | template CI `image` |
| Sentry on/off | D2 | `tests/instrumentation.test.ts` |
| prod compose up, status 401/200, version, idle stop | D3 | `tests/e2e/prod-compose.e2e.ts` |
| approval across a step-changing redeploy, `attempt = 2` | D4 | `tests/e2e/redeploy.e2e.ts` |
| OpenAPI-validated clients; 0600 state | E1 | `packages/cli/src/providers/*.test.ts` |
| roles over a runner; cold-run rotation | E2 | `roles.test.ts` |
| idempotent / resumable ten steps | E3 | `new.test.ts` |
| doctor warnings | E4 | `doctor.test.ts` |
| restore counts match / mismatch | E5 | `restore-check.test.ts` |

## Open questions (Graham's; answer in one pass)

1. **Publish `0.1.0` by hand in chunk 0?** *Recommend yes.* Alternatives: build core inside the app image from a
   pinned sha (every deploy rebuilds nine packages, and `link:` semantics inside Docker are fragile) or commit
   `pnpm pack` tarballs to each app (binary churn in every bump PR). Trade-off: a version is on npm before Phase 4's
   api-diff gate exists — acceptable, `0.x`. **Blocks chunk 0.**
2. **Domain scheme** — `<app>.hyperfixation.ai`, DNS-only (Coolify's proxy terminates TLS)? *Recommend yes*;
   Cloudflare-proxied would need Full-strict and hides the box from Coolify's ACME challenge. **Blocks E3.**
3. **Defer the document bucket and scoped key to Phase 6?** *Recommend yes* (no consumer, no env name, and Still-open 1
   about key scoping is unanswered). Trade-off: Phase 6 gains one provisioning step.
4. **Metabase: create the `_ro` role and print the connection in the checklist, no Metabase API call?**
   *Recommend yes*; the API adds a session-auth client for one optional form.
5. **`downstream.txt`:** `hf new` prints the line; Phase 4 creates the file. *Recommend print* — the CLI runs from npm
   on a laptop and has no core checkout to write into.
6. **Cloud budget:** `hf new --budget-usd` required with no default? *Recommend required* (matches `hf bootstrap`'s
   "a deployed app never starts under a cap nobody chose").

## Stale or contradicted in the plan

- Phase 3 "`hf new` in the cloud" versus Phase 4 "npm publish" — see the concern at the top; the template's comments
  already say Phase 3.
- v1 "reports through the write-token status endpoint" — no such route; correction 2.
- v1 "install the bot's credentials as repo secrets" — nothing in `ci.yml` or `core-bump.yml` reads a secret; dropped
  for an installation check.
- Exit "connection count stays under budget" — bounded, not flat (Phase 2 measured a peak of 9).
- `Dockerfile` `node:25-alpine` versus `engines >=22` and CI 22 — aligned in chunk 0.
- Plan §Deployment "Sentry is initialised in both" — false today; D2.
- `hf doctor` "lists open core-bump PRs" is harmless but empty until Phase 4 dispatches any.

## Risks

1. **Coolify API shapes** (`/applications/private-github-app`, `/envs/bulk`, deployment polling, backup registration)
   are named from memory; E1's vendored OpenAPI is what pins them — vendor the doc from the box's own Coolify version
   first.
2. **`SOURCE_COMMIT`**: the fallback makes a miss loud, not silent; first manual item.
3. **Where a backup lives and whether `databases_to_backup` is API-settable.** If Coolify keeps dumps only in S3 or the
   field is UI-only, E3's backup step becomes a checklist line and E5 downloads from S3 with the operator key. Verify
   on the box before E5.
4. **D4's CI cost** (two image builds); if > 10 min, keep it as a manually triggered workflow and rely on redeploy
   case 1 and the box check.
5. **Passkeys and `APP_URL`**: a wrong origin silently breaks enrolment; the checklist must state the exact origin
   Coolify serves.

**Recommended adversary targets before starting:** (a) the state cache — a half-written state file after a crash
mid-step, and a cold run rotating a password while the deployed app still uses the old one (order: rotate → Coolify
env → redeploy); (b) `restore-check` naming a table that exists in the dump but not live (an app migration between the
backup and the check); (c) E3's env list drifting from `REQUIRED_ENV` — assert equality in `new.test.ts`.

**Verification, per chunk:** core `pnpm -w typecheck lint test api-extractor` from a clean clone; template
`pnpm typecheck lint test`, `pnpm test:e2e` in a generated app, `docker compose -f docker-compose.prod.yml config`;
named gate `pnpm --filter @hyperfixation/cli test`.
