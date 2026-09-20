# Hyperfixation X1 runbook — `hf new demo-app` against the real box

**Date:** 2026-09-20. Planner output. Refs: core `origin/main` `580209e`, template `origin/main` `65df6e4`. Written from `packages/cli/src/*`
at that ref; anything marked **UNVERIFIED** needs the box. Gaps 2, 4 and 5 below are being fixed in follow-up PRs (`Chunk: X1-fixes`); Gap 1 is
the `0.1.1` publish plus template #33.

## 0. What this run creates, costs, and touches

It is **not a rehearsal**: every step hits the production Coolify box, the real Cloudflare zone, GitHub, Sentry and Langfuse. Created, in step
order (`state.ts:17-28`): a local directory `./demo-app` with a `pnpm install` and one commit; the private repo `<HF_GITHUB_OWNER>/demo-app`; a
**daily backup schedule** on the Coolify Postgres for `hf_demo_app`; Sentry project `<HF_SENTRY_ORG>/demo_app`; Langfuse project `demo_app` plus a
key pair; DNS `A demo-app.<HF_BASE_DOMAIN>` → `HF_BOX_IP`, DNS-only; database `hf_demo_app` with `vector`, `pg_trgm` and roles
`hf_demo_app_migrator`, `hf_demo_app` (limit 25), `hf_demo_app_ro` (limit 4); Coolify project `demo-app` with application `demo-app`
(docker-compose build pack, `https://demo-app.<base>`) and 10 env vars; migrations, the bootstrap admin, the two status tokens; one deploy. Box
cost: one image build plus three containers (`mem_limit` 256/512/768 MB). LLM cost: zero if you leave `HF_ANTHROPIC_API_KEY` and
`HF_OPENAI_API_KEY` unset (fixtures).

Not touched: any other Coolify project or database, other DNS records (an existing `A` at that name with a different address aborts,
`dns.ts:40-46`), the box's Postgres config, the core or template repos.

## 1. Prerequisites

**1a. The publish.** `pnpm release:verify 0.1.1` (in core) must exit 0 (`0.1.1 checks out locally and on https://registry.npmjs.org.`). Until it
does, publish with `pnpm release:publish 0.1.1` (visible terminal, 2FA). The template must consume it: template #33 bumps every
`@hyperfixation/*` to `^0.1.1` and wires `reportProvidersMode`; its lockfile must be regenerated against the real registry and merged, because
a cloud `hf new` fetches the template's `origin/main` (`template-source.ts:11`). Check: `git -C <template> show origin/main:pnpm-lock.yaml |
grep -c "@hyperfixation/core@0.1.1"` prints a number ≥ 1.

**1b. The `hf` binary.** `bin` is `hf` → `dist/bin.js`. After the publish: `npm install -g @hyperfixation/cli@0.1.1`, then `hf --help` shows the
USAGE with `hf new <name>` and `--budget-usd`, `--email`, `--from`, `--into`. Before the publish, build core (`pnpm -r build`) and use `node
/Users/grahamlutz/Code/hyperfixation/packages/cli/dist/bin.js` in place of `hf`.

**1c. Operator config** at `~/.config/hf/config.json`, a flat JSON object of strings, **mode 0600** (a looser mode is tightened then refused,
`secret-file.ts:49-52`); any key may instead be an env var, which wins (`config.ts:120-123`). Unknown keys are refused (`config.ts:177`).

| Key | Value / where |
|---|---|
| `HF_COOLIFY_URL` | Coolify dashboard origin, no path (`/api/v1` is appended, `providers/coolify.ts:123`) |
| `HF_COOLIFY_TOKEN` | Coolify → Keys & Tokens → API tokens → Create; needs write, not read-only |
| `HF_COOLIFY_SERVER_UUID` | Coolify → Servers → the box → uuid in the URL |
| `HF_COOLIFY_GITHUB_APP_UUID` | Coolify → Sources → the GitHub App → uuid in the URL |
| `HF_COOLIFY_POSTGRES_UUID` | Coolify → the Postgres resource → uuid in the URL |
| `HF_DB_HOST_INTERNAL` | optional; the Postgres container's name on the `coolify` network; defaults to the uuid (`coolify.ts:148`). X1 question 3 |
| `HF_DB_CONTAINER` | optional; the container `docker inspect` is asked for the cluster's address; defaults to trying the bare uuid and then `postgresql-<uuid>` (`config.ts`, `database.ts`) |
| `HF_PG_ADMIN_USER` | optional; the cluster superuser to log in as, for a box whose Coolify `POSTGRES_USER` is not `postgres`; the password stays in `PGPASSWORD` |
| `HF_SSH_HOST` | `root@<box-ip>`; must match `^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$`; key auth only (`BatchMode=yes`, `runner.ts:59-66`) |
| `HF_CLOUDFLARE_TOKEN` | Cloudflare → My Profile → API Tokens → Create → "Edit zone DNS", scoped to the zone |
| `HF_CLOUDFLARE_ZONE_ID` | Cloudflare → the zone → Overview → right column "Zone ID" |
| `HF_BASE_DOMAIN` | `hyperfixation.ai` (decided) |
| `HF_GITHUB_TOKEN` | GitHub → Settings → Developer settings → Tokens (classic) → `repo`. Used for `POST /user/repos`, push, `GET /user/installations` (**UNVERIFIED** that a classic PAT may call it — pre-flight), refs, pulls, statuses |
| `HF_GITHUB_OWNER` | `grahamlutz` |
| `HF_GITHUB_APP_SLUGS` | comma-separated slugs of Coolify's GitHub App and `hyperfixation-bot`, from `github.com/settings/apps/<slug>`; both must be installed with access to the new repo, or the repo step fails naming the URL (`repo.ts:119-129`). Install with "All repositories" to avoid a chicken-and-egg on a repo that does not exist yet |
| `HF_SENTRY_TOKEN` | Sentry → Settings → Auth Tokens → Create; scopes `project:write`, `project:read` |
| `HF_SENTRY_ORG` | the org slug from the Sentry URL |
| `HF_LANGFUSE_URL` | `https://cloud.langfuse.com` (or the region host) |
| `HF_LANGFUSE_ORG_KEY` | `pk-lf-…:sk-lf-…` from Langfuse → Organization settings → API Keys (organization-scoped); sent as HTTP Basic (`providers/langfuse.ts:40`). X1 question 1 |
| `HF_BOX_IP` | Hetzner console → the server → IPv4 |
| `HF_SMTP_URL` | `smtp://user:pass@host:587` of a real relay — sign-in is an emailed code, so this must deliver |
| `HF_EMAIL_FROM` | a sender that relay accepts |
| `HF_ANTHROPIC_API_KEY`, `HF_OPENAI_API_KEY` | **leave unset for X1** — the app serves fixtures and costs nothing |

`~/Code/hyperfixation-secrets/` holds Phase 0 files named `coolify.env.backup-2026-09-16`, `postgres-roles-2026-09-16.env`,
`langfuse-2026-09-16.env`, `sentry-2026-09-16.env`, `hetzner-s3-credentials-2026-09-16.env`, `anthropic-2026-09-16.env` and
`hyperfixation-bot.2026-09-16.private-key.pem`. The bot PEM and the S3 key are not needed by `hf`. The cluster superuser password is **not** a
config key: export it as `PGPASSWORD` in the shell that runs `hf new`, `hf doctor` and `hf restore-check` (`new-cloud.ts:245-248`,
`restore-check.ts:352`).

## 2. Pre-flight (changes nothing)

Tokens are pulled from the config with `jq` so none is typed or echoed.

1. `hf doctor` → `no apps in the state cache: hf new has provisioned none`, exit 0 (proves the file parses and the base keys are set).
2. SSH and the Postgres container: `ssh -T -o BatchMode=yes "$(jq -r .HF_SSH_HOST ~/.config/hf/config.json)" 'docker ps --format "{{.Names}}"'` → a container named for `HF_COOLIFY_POSTGRES_UUID`, either bare (a standalone Postgres resource) or `postgresql-<uuid>` (a service's database). No `127.0.0.1:5432` listener is required any more: Coolify publishes no port, so the tunnel asks `docker inspect` for the container's address on the `coolify` network and forwards to that with the box as the hop (`database.ts`). **If neither name is in `docker ps` the run fails at step 8** naming both — set `HF_DB_CONTAINER` to the real one. X1 question 4.
3. `PGPASSWORD` over the tunnel: read the container's address with `ssh <host> 'docker inspect -f "{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}}={{\$v.IPAddress}} {{end}}" <container>'` (this is the command `hf` itself runs), open `ssh -L 15432:<that IP>:5432 <host>` and run `psql "postgresql://postgres@127.0.0.1:15432/postgres" -c 'select 1'` → `1`. A box that does publish 5432 can use `127.0.0.1` instead.
4. Coolify API: `curl -sf -H "Authorization: Bearer <token>" <url>/api/v1/projects | jq 'map({name, uuid})'` → the existing projects (no `demo-app`). List one project's environments (`…/projects/<uuid>/environments | jq 'map(.name)'`) → `["production"]`; anything else makes step 9 fail with "has no production environment" (X1 question 2).
5. Cloudflare: `GET /client/v4/zones/<zone>` → `success: true` and your base domain.
6. GitHub installations: `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer <token>" https://api.github.com/user/installations` → `200`. `403`/`404` means a classic PAT cannot list installations; step 3 would fail after creating the repo — switch to a fine-grained token first.
7. Langfuse: `curl -s -o /dev/null -w '%{http_code}' -u "<org key>" <url>/api/public/projects` → `200` (X1 question 1). `401`/`403` means step 6 will fail and Langfuse needs a manual project (Gap 6).

## 3. The run

Names: given `demo-app` → app `demo_app`, database/app role `hf_demo_app`, migrator `hf_demo_app_migrator`, RO `hf_demo_app_ro`, FQDN
`demo-app.<base>` (`names.ts:42-64`). State: `~/.config/hf/state/demo-app.json` (0600, written after every step).

`cd ~/Code && hf new demo-app --budget-usd 10 --email graham.lutz@gmail.com` — both flags are required with no defaults (`cli.ts:205-215`);
nothing is prompted. `pnpm install` output streams live; every other step prints one line:

| # | Step | Prints | If it fails |
|---|---|---|---|
| 1 | template | `demo-app: template fetched into …` | `--from` wrong or no `.hyperfixation-template` marker; no directory left behind |
| 2 | install | `demo-app: N file(s) in the initial commit` | `pnpm install exited …`; re-run resumes (a HEAD commit is the "done" mark) |
| 3 | repo | `created the private repository grahamlutz/demo-app` | App-not-installed message with the install URL; the repo is adopted only if its `main` equals local HEAD |
| 4 | backup | `registered a daily backup of hf_demo_app` | Coolify 4xx; the step **cannot detect its previous work** (X1 q6) — a re-run after this succeeded once registers a second schedule; check Coolify → the database → Backups |
| 5 | sentry | `created the Sentry project <org>/demo_app` | re-run adopts |
| 6 | langfuse | `created the Langfuse project demo_app` | re-run adopts by name but always mints a new key pair |
| 7 | dns | `demo-app.<base> A <ip>, DNS-only` | an existing record with another address aborts, never overwritten |
| 8 | database | `created hf_demo_app, roles …` | tunnel or `PGPASSWORD` failure; nothing created |
| 9 | coolify | project → application → `10 environment variable(s) set in Coolify` → `migrated hf_demo_app` → `bootstrapped … with a $10 budget` → `minted the /api/status read and write tokens` | `EnvDrift` before any request; "no production environment"; migrate/bootstrap child errors |
| 10 | deploy | `deployment <uuid> queued` … `serving <sha7> at https://demo-app.<base>` | 15-minute deadline (`deploy.ts:13`); `ended failed` → Coolify's build log; `never reported <sha>` → `SOURCE_COMMIT` did not reach the image (X1 q5, Risk 2) |

Then the checklist (section 5), including the **write token, printed once**; copy it somewhere safe.

**Re-run rule.** The same command again is safe: recorded steps are skipped; a rerun after a rotation re-PATCHes and redeploys automatically
(`new-cloud.ts:127-139`). **Do not delete the state file** unless you mean a cold run: it rotates all three passwords
(`provision-database.ts:99-102`), mints a Langfuse key, may double the backup schedule, and if the run then stops before step 9 the deployed app is
locked out until you re-run (the runner refuses to call that "finished", `new-cloud.ts:110-117`). Watch progress in Coolify → the application →
Deployments during step 10.

## 4. Verify

1. `hf doctor demo-app` → `OK` for `status` (health ok), `runs`, `version` (`applicationVersion <sha7> is main`), `budget` (current period, no drift), `E006`, `core-bump`; one `WARN restore-check: never run`, exit 1. Anything else is a finding.
2. `/api/status` with the read token (`jq -r .statusTokens.read ~/.config/hf/state/demo-app.json`): `applicationVersion` equals `git -C ~/Code/demo-app rev-parse HEAD`; `coreVersion` `0.1.1`; `llm.mode` (see Gap 3: `unknown` until the template's worker reports, then `fixtures`). Without a token it must be `401`.
3. **Backup and restore.** `backup_now` is false (`backup.ts:43`), so trigger one: Coolify → the Postgres → Backups → the `hf_demo_app` schedule → Backup Now. Then `hf restore-check demo-app` → a table `table live restored verdict` with every `hf_*` row `ok`, `N table(s) matched`, exit 0; it looks under `/data/coolify/backups` (`backup-source.ts:5`). `no hf_demo_app dump` means the dump landed elsewhere (S3 only, Risk 3): find it on the box with `find /data/coolify -name '*hf_demo_app*'` and pass `--backup-dir`.
4. **Sign-in and passkey.** On a phone, open exactly `https://demo-app.<base>/auth/sign-in`, use the emailed code, then `/auth/passkey`. Evidence: `SELECT count(*) FROM hf_passkey` = 1 (via the tunnel as `postgres` on `hf_demo_app`).
5. **Demo loop.** The worker fires `collect`, `resolve`, `score` at its first 30 s tick and every 10 min. The draft flow has **no schedule** and (Gap 4) no UI trigger until the admin "run the draft flow" control lands. Run it twice for two drafts, approve from the phone at `/w/approvals`. Evidence: `SELECT id, status, decided_by, batch_id FROM hf_approval` — both `approved`, one `batch_id`, `decided_by` your user id; two `ok` rows in `hf_action_log`.
6. **SIGTERM mid-run.** While a `resolve` run is `running` (`SELECT id, status FROM hf_run`): on the box, `docker kill -s TERM <worker>`, then `docker inspect -f '{{.State.FinishedAt}} exit={{.State.ExitCode}}' <worker>`: `FinishedAt` minus the signal time ≤ 61 s (60 s drain + 1), exit 0. At the instant it exits, on the tunnel, `pg_locks` for advisory locks in `hf_demo_app` is empty until the new worker logs `hf-worker: advisory lock acquired`. Container names under Coolify's compose are **UNVERIFIED**.
7. **Memory limits.** `docker inspect -f '{{.Name}} {{.HostConfig.Memory}}'` of web, worker (and migrate if present): web `536870912`, worker `805306368`, migrate `268435456`; `docker stats --no-stream` shows usage under each.
8. **30-minute soak.** Sample `select count(*) from pg_stat_activity where usename = 'hf_demo_app'` every 10 s for 30 minutes on the box. **Bounded** means the peak stays under 24 (the role limit is 25); it moves because `pg.Pool` idles out after 10 s, so it is not flat.
9. **E006 as the app role** (tunnel, database `hf_demo_app`): `SET ROLE hf_demo_app; SELECT has_schema_privilege('dbos','USAGE'), has_table_privilege('dbos.workflow_status','INSERT');` → `t | t`.
10. **First-of-month** — a calendar item for 1 Oct: `/api/status` `budget.current.spentUsd = "0"`, `previous` unchanged, both `driftUsd = "0"`. Mark "later".

Evidence table to paste into the Phase 3 doc's Exit section: `hf new` exit 0 + checklist; `applicationVersion` = pushed sha; whether the `hf-build:` fallback fired (Coolify build log); `llm.mode`; `hf restore-check` table and exit code; passkey from the phone (`hf_passkey` count, screenshot); the batch approval rows; SIGTERM drain (`FinishedAt` minus signal, exit code); `pg_locks` at exit; memory limits; soak peak; E006 `t t`; first-of-month (later).

## 5. Finish — the printed checklist

- **Fixtures line:** expected; leave until you paste `ANTHROPIC_API_KEY` into Coolify → the app → Environment Variables and redeploy (it is already in `REQUIRED_ENV`; nothing to add).
- **New third-party keys:** add to `REQUIRED_ENV`, `.env.example` and all compose blocks, then Coolify — `hf new` refuses the next run on drift (`coolify.ts:113-121`).
- **Metabase:** `postgres://hf_demo_app_ro:<password>@<dbHost>:5432/hf_demo_app`; the password is `database.readonlyPassword` in the state file; Metabase must sit on the `coolify` network.
- **`downstream.txt`:** note the line `grahamlutz/demo-app`; the file is Phase 4's.
- **Core-bump PRs:** merge only green; `hf doctor` lists them.
- **Backup duplicate line:** check Coolify once.

## 6. Teardown

There is **no `hf destroy`**; `hf` removes nothing. Manual, in this order:

1. Coolify → project `demo-app` → application → Delete (with volumes and images); then delete the project. Then the Postgres resource → Backups → delete the `hf_demo_app` schedule (and its dumps under `/data/coolify/backups` if you want the disk back).
2. Database and roles, via a tunnel as `postgres`: `DROP DATABASE hf_demo_app WITH (FORCE); DROP DATABASE IF EXISTS hf_demo_app_restore_check; DROP ROLE hf_demo_app_ro; DROP ROLE hf_demo_app; DROP ROLE hf_demo_app_migrator;`
3. DNS: look up the record id (`GET /client/v4/zones/<zone>/dns_records?type=A&name=demo-app.<base>`, `.result[0].id`) and `DELETE` it with the same header.
4. GitHub: `gh repo delete grahamlutz/demo-app --yes`.
5. Sentry → Settings → Projects → `demo_app` → Remove Project. Langfuse → project `demo_app` → Settings → Delete (also revoke the `hf new demo-app` key).
6. Local: remove `~/.config/hf/state/demo-app.json`, `~/Code/demo-app` and `~/Code/.demo-app.hf-new`; uninstall `@hyperfixation/cli` globally if you prefer `npx`.

## 7. Gaps found

1. **0.1.1 is unpublished and the template pins 0.1.0.** A cloud `hf new` fetches the template's `origin/main`, so the deployed app would run core 0.1.0 while the CLI is 0.1.1. Closed by the publish and template #33.
2. **`hf doctor` crashes on a 0.1.0 app:** `doctor.ts:261` reads `report.llm.mode`; a 0.1.0 `/api/status` has no `llm` key, so it throws outside the `getStatus` try. **Fix in flight (`X1-fixes`).**
3. **`llm.mode` never says `fixtures`:** template `worker.ts` does not call `reportProvidersMode(pool)` until template #33 lands (needs the 0.1.1 publish). Expect `unknown` until then; the checklist's `llm.mode=fixtures` sentence (`checklist.ts:40-41`) is wrong until the template changes. **Sentence fix in flight.**
4. **No way to start the draft flow in production:** only the schedules and the e2e harness call `runs.start`. **Fix in flight: an admin-only "run the draft flow" control in the template.**
5. **"All keys checked before the first step" is only partly true:** `REQUIRED_CLOUD_CONFIG` (`new-cloud.ts:181-192`) omits `HF_GITHUB_*`, `HF_SENTRY_*`, `HF_LANGFUSE_ORG_KEY`, `HF_CLOUDFLARE_*`, `HF_BOX_IP`; a missing one fails at its step after earlier creates. Harmless (resumable) but contradicts the comment at `new-cloud.ts:174-179`. **Fix in flight.**
6. **Langfuse lookup by org key** (`langfuse.ts:34`): the vendored endpoint is project-scoped; pre-flight 7 decides.
7. **The Coolify OpenAPI is upstream `main`, not the box's version** (`openapi/README.md:31-35`); re-vendoring before X1 was the stated rule and has not happened.
8. **Postgres loopback port, `HF_DB_HOST_INTERNAL`, `SOURCE_COMMIT`, Coolify container names, backup location:** all UNVERIFIED (X1 questions 3 to 6); the pre-flights and the deploy step's error text surface each.
9. **Restore-check needs a dump that `hf new` never triggers** (`backup_now: false`), and dumps may go to S3 only (Phase 0 configured S3; `--from-s3` is a refusal, `backup-source.ts:128-140`).
10. **A local template checkout can be stale** (it was 22 commits behind); `hf new --local` from it would copy the `link:` layout. Irrelevant to the cloud run; `git pull` it anyway.

**Recommended adversary targets before running:** the loopback-port assumption (pre-flight 2), the deploy step's `SOURCE_COMMIT` path, and the cold-run
rotation ordering.
