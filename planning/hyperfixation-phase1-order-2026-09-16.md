# Hyperfixation Phase 1 — implementation order

**Date:** 2026-09-16. Derived from [hyperfixation-plan-2026-09-15.md](hyperfixation-plan-2026-09-15.md) as revised
after adversary rounds 2 and 3. **The design is fixed; this document only orders it.** Where this document
disagrees with the plan about *what* to build, the plan wins. Where it disagrees about *when*, this one does.

## Three corrections this ordering pass produced

1. **Phase 1's gate requires Phase 2's tables.** `redeploy.test.ts` cases 1, 2, 3, 8, 9 and 12 assert on
   `hf_llm_call`, `possible_double_charge`, the derived reservation, `spent_usd`, `BudgetExceeded`,
   `hf_action_log`, and a completed `decide()`. Phase 1's `@hyperfixation/db` bullet lists neither ledger
   table, and the ledger/actions/approvals protocols are "fixed here" in Phase 2. Phase 1 therefore pulls
   forward a **minimum ledger slice** (chunk 10) and a **minimum approvals slice** (chunk 12); everything
   else in those protocols stays in Phase 2. The plan already half-draws this line — case 9 defers the
   abandoned-row-revisited case to Phase 2's `kill-switch.test.ts` — it just does not move the tables.
2. **`fence.test.ts` cases (i)–(vi) need no DBOS launch.** Two pools, the classifier, `ctx.tx`, `hf_run`,
   the bump path and the control-plane commit helper are the whole dependency set. This makes the fence
   track and the worker track genuinely parallel after chunk 3, and makes "fence green" a milestone that
   lands well before any redeploy case. Case (vii) is the exception: it needs `DBOS.isWithinWorkflow()`
   true, so either mock that predicate or defer (vii) to chunk 13.
3. **The statement classifier is the highest-risk item and the cheapest to de-risk.** The plan names it
   itself ("not verified in round 3 and now load-bearing", adversary target (a)). It is a pure function
   over SQL text — no database, no DBOS, no other package. Spike it on day one. If the interception layer
   is on the wrong level of node-pg (the `Submittable` path, which is how `pg-copy-streams` works, and
   resolution's `COPY` runs inside `ctx.tx`), the fix is structural and everything downstream is built on
   sand.

## Is the repo skeleton safe to scaffold now?

**Yes.** The 8-package layout in "Repo and package layout" is stable under this ordering. The one thing
that could have added a package — a shared test-database utility, needed because `@hyperfixation/db`'s own
tests want a provisioned database while `@hyperfixation/testing` owns provisioning — resolves without one:
the migrator and role provisioning live in `db` (where the plan already puts them) and `testing`'s
"per-run database from a template" is a thin wrapper that calls it. No package cycle.

Two carve-outs:

- **`@hyperfixation/db`'s `exports` map stays a placeholder until chunk 4.** "No export resolves to the
  control pool" is contract surface, and which module holds the control pool is a chunk-4 decision.
- **Scaffold all 8 packages including `@hyperfixation/ai`**, which now starts in Phase 1 rather than
  Phase 2 — it holds the minimum ledger slice (chunk 10).

Round 3's open question on the budget period key was **closed on 2026-09-16: UTC calendar months.** It
never blocked scaffolding — `period` is `text` under any answer — and the stamp expression ships with
Phase 2's gate.

## Confirming the load-bearing claim

The plan's claim — migrator, boot checks and the pool factories are load-bearing for everything else —
holds, and tightens:

- **Migrator is root.** Round-3 finding 4 was live-reproduced: without `dbos schema -s dbos -r hf_<app>`
  the worker cannot launch at all (`42501`). Every workflows test fails at boot, not at its assertion.
- **Boot checks precede workflows.** E001–E006 run as the first statements of both `startWorker()` and
  `getClient()`, so they are inside the thing they gate.
- **Pool factories precede the step wrapper.** `ctx.tx`'s fence is a property of a tagged connection, so
  the pool that enforces the tag must exist before the wrapper that sets it.

One addition the plan does not state: **the crash harness is critical path, not testing-package polish.**
`spawnWorker`/`killAt` gate 9 of the 12 redeploy cases (all but 5, 6 and 10). Build it as soon as a worker
launches.

## Infra: what blocks, what stubs

| Needs real infra | Why it cannot be stubbed |
|---|---|
| Two Postgres roles + grants | E006 and case 10 are *about* role-scoped privilege |
| `dbos schema -s dbos -r <role>` | Case 10 asserts the real grant set; the SDK CLI is the only grant path |
| `pg_try_advisory_lock` | Cheap, real pg, independent — testable very early |
| `FOR UPDATE` / `FOR SHARE` blocking (fence i, vii) | These tests *are* the concurrency semantics |
| `COMMIT` returning a `ROLLBACK` tag (fence v) | node-pg + real pg behaviour; the whole point of finding 5 |
| `enqueueInTransaction`, `dbos.workflow_status` | Real SDK against real pg |
| Queue concurrency under load (case 12) | 50 runs at `llm` concurrency 4 |

| Builds with no infra | Note |
|---|---|
| Statement classifier | Pure function + corpus; **start immediately** |
| Drizzle schema definitions | Pure TS |
| `migration-policy.test.ts`, journal snapshot | Parses migration SQL text; no database |
| ESLint shared config + ban fixtures (case 5) | Lint only |
| API Extractor wiring, deep-import `tsc` fixture | No database |
| Template Dockerfile/compose + `compose-envs.test.ts` | File parsing against `REQUIRED_ENV` |
| Session-factor policy logic | Testable against a fake session; integration needs a database |
| `hf new --local` copy + placeholder substitution | Temp dir; `hf migrate` needs a database |

Explicitly **out of Phase 1**: `withClock(pgTimestamp)`. No Phase 1 gate case manipulates the clock — the
period-boundary cases are Phase 2's `budget.test.ts`. Do not build it yet.

---

## The spine (serial)

Each chunk is one PR. The done-check is the named test that first passes because of it.

### 0 — Repo skeleton and toolchain

pnpm workspaces, Turborepo, the 8 package directories with `package.json`/`tsconfig`/empty `src`,
`registry/`, changesets with one fixed version group, root vitest config, CI skeleton with a Postgres
service. `exports` maps are placeholders.

**Done:** `pnpm install && pnpm turbo typecheck` green across all 8 empty packages; a changesets `version`
dry run bumps all 8 in lockstep.

### 1 — Statement classifier (spike)

`classify(sql): 'read' | 'write'` over `pgsql-ast-parser`, cached by statement text, **unparseable counts
as a write**. Corpus must include: plain `SELECT`; `SELECT … INTO`; `SELECT pg_notify(…)`;
`SELECT setval(…)`; a `SELECT` calling a volatile function; `WITH … INSERT/UPDATE/DELETE RETURNING`;
`BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`; `SET` and `SET LOCAL`; `COPY … FROM STDIN`; and every statement
Drizzle emits for the `hf_*` schema (generate them with Drizzle's `toSQL()`).

Also settle the **interception layer** here: the wrapper must see `client.query(string)`,
`client.query({text, values})`, `client.query(Submittable)` and `pool.query(…)`. Rule that falls out
cleanly: **writes succeed only on an explicitly checked-out, tagged client**, so `pool.query('UPDATE …')`
is refused by construction, and so is Drizzle's `db.transaction()` outside `ctx.tx` (its `BEGIN`
classifies as a write).

**Done:** corpus test green; a `pg-copy-streams` COPY is visibly classified by the wrapper; any
"writes but parses as a read" residual is documented with a test asserting the documented behaviour.

**Parallel with chunk 0.** This is the de-risking spike — if it fails, it fails before anything is built on it.

### 2 — Schema and migrations

Drizzle definitions: the better-auth tables mapped to `hf_user`/`hf_session`(+`factor`)/`hf_account`/
`hf_verification`/`hf_passkey`/`hf_organization`/`hf_member`; `hf_app_state`; `hf_audit`; `hf_run`;
`hf_budget_period`; **and, pulled forward, `hf_llm_call` and `hf_action_log`** with the partial index
`(period, run_id, workflow_id) INCLUDE (estimated_cost_usd) WHERE status = 'started'` and `(period, status)`.
Generated migrations plus the journal.

**Done:** `migration-policy.test.ts` green including the `DROP COLUMN` and `CREATE FUNCTION` rejection
fixtures; journal snapshot test green (may only grow).

### 3 — Migrator, two roles, boot checks E001–E006

The five-step migrator run as the migrator role: core migrations → app migrations →
`dbos schema -s dbos -r hf_<app>` → delete-guard triggers → `hf_grant_ro`. Role provisioning: migrator role
owns every `hf_*` object and the `dbos` schema; application role `hf_<app>`, `CONNECTION LIMIT 25`, owns
nothing. E001–E006 as standalone callable checks.

**Done: `redeploy.test.ts` case 10, both halves.** Against a fresh database, run the migrator as the
migrator role, then as the application role assert `has_schema_privilege('dbos','USAGE')` and
`has_table_privilege('dbos.workflow_status','INSERT')`. Against a second fresh database, run the migrator
*without* the `-r` step and assert a process calling the boot checks exits naming **E006** — never a raw
`42501` from inside a transaction. Plus `pnpm --filter @hyperfixation/db test boot-checks`.

**First hard infra dependency.** Real pg17 + the DBOS CLI. Nothing here can be stubbed.

> **After chunk 3 the tree forks.** Chunks 4–5 (fence) and 6–7 (worker) are independent; see Parallelism.

### 4 — Pool factories and `ctx.tx`

Step pool (8 connections) and control pool (2), built over node-pg at the layer chunk 1 settled. Non-read
statements refused with `UnfencedWrite` unless the client is *currently tagged*; the tag is set by `ctx.tx`
for exactly the life of its transaction and removed before the client returns to the pool. Control pool is
in no package's `exports` map. `ctx.tx(runId, workflowId, work)` checks out, tags, opens the transaction
whose first statement is
`SELECT 1 FROM hf_run WHERE run_id = $1 AND current_workflow_id = $2 FOR SHARE` (zero rows → `StaleAttempt`,
rollback), runs `work` against a Drizzle handle bound to that client, then untags.

At this stage `ctx.tx` takes `runId`/`workflowId` explicitly; chunk 9 supplies them from DBOS context. That
seam is what lets `fence.test.ts` run without a launch.

**Done: `fence.test.ts` case (vi)** — all six escape shapes refused (module-level `setInterval` flusher;
`EventEmitter` registered inside a step and emitted from a timer outside; `INSERT` from a `defineFlow` body
before its first `step()`; a sibling-directory helper importing `@/db`; `db.transaction()` on the step pool
outside `ctx.tx`; a handle captured inside `ctx.tx` and used after commit) — while a plain `SELECT` from
each succeeds and the same writes inside `ctx.tx` succeed.

### 5 — `hf_run`, the one bump path, the control-plane transaction helper

**Bump path** (the only one, used by `runs.start`, `decide()`, `resume`, `reconcile()`): lock `hf_run`
`FOR UPDATE`, read `N`, compute `N + 1` **in application code**, write
`attempt = N+1, current_workflow_id = run_id || ':' || (N+1)` with `WHERE run_id = $1 AND attempt = $N`
(row count must be 1), assert no `dbos.workflow_status` row exists for the new id
(`WorkflowIdCollision`, never a silent no-op), `enqueueInTransaction` on the same client, commit through
the helper.

**Control-plane helper:** `assertNotInWorkflow()` first; `SET LOCAL lock_timeout = '30s'` as the first
statement; commit issues `COMMIT` and throws `CommitLost` unless `result.command === 'COMMIT'`; any error
issues `ROLLBACK` and releases the client *with* the error so the pool destroys it. Nothing inside catches.

**Done: `fence.test.ts` cases (i), (ii), (iii), (iv), (v) and (vii)** plus the unit test from redeploy
case 8 — two sequential bumps on one row yield `:2` then `:3`. Case (vii) mocks `DBOS.isWithinWorkflow()`
so the file keeps its "no DBOS launch" contract; `records.archive()`'s half of it lands at chunk 13, when
the function exists to guard.

> **Milestone: `fence.test.ts` green.** The hardest mechanism in Phase 1 is proven and no worker has launched.

### 6 — `startWorker()`, launch half

E001–E006 first. Build both pools. Take `pg_try_advisory_lock(hashtext('hf-worker:' || appName))` on a
dedicated connection **never closed by code**. Guard: throw if `DBOS.launch` is reached with
`HF_PROCESS !== 'worker'`. `DBOS.launch` with the fixed option set — `applicationVersion` from
`HF_BUILD_SHA` (throw if unset or under 7 chars), `enablePatching: false`, `runAdminServer: false`,
`systemDatabaseSchemaName: 'dbos'`, `systemDatabasePoolSize: 5`, `maxConcurrentQueueDispatches: 1`,
`runMigrations: false`, `executorID: 'worker'`. Queues `llm` (4), `actions` (2), `resolve` (1) via
`DBOS.registerQueue`, names sourced only from the flow registry. `getClient()` singleton after E006.

**Done: redeploy case 6** (a second worker exits non-zero without calling `DBOS.launch`), **case 10's launch
half**, and the worker-isolation test (`hf migrate`, `next build`, and a vitest import never call
`DBOS.launch`).

### 7 — SIGTERM handler

Exactly the round-3 verified shape: a **non-`async`** listener; module-level `shuttingDown` boolean that
logs and returns on a second delivery; `setTimeout(() => process.exit(1), 75_000).unref()` armed
**synchronously before any await**; then
`DBOS.shutdown({ workflowCompletionTimeoutMS: 60_000 }).then(() => process.exit(0), err => { log(err); process.exit(1) })`
with both arms explicit and nothing awaited. Lock connection never `.end()`ed.

**Done: redeploy case 11**, both halves — double SIGTERM 50 ms apart exits 0 within the drain with one
`shutdown` log line and no "Called end on pool more than once"; and a monkey-patched rejecting `shutdown`
with `@sentry/node`'s default `unhandledRejection` listener installed exits 1 within 1 s, not 75.

**Parallel with chunks 8–13** — it needs only chunk 6.

### 8 — Testing package: per-run database and crash harness

**8a** (needs chunk 6): per-run database from a template, calling db's migrator and role provisioning;
`HF_BUILD_SHA = 'test-<uuid>'` per process; `MockLanguageModel` cassette; `spawnWorker({version, module, drainMs?})`;
the rule that any `UnfencedWrite` or `ControlPlaneInWorkflow` raised during a test fails it (the package
detects nothing — it makes the production refusal fatal).

**8b** (needs chunk 9): `killAt(stepKey, 'before-checkpoint' | 'after-checkpoint' | 'in-tx')`, where
`'in-tx'` parks the process inside an open `ctx.tx` after the fence statement.

**Done:** a smoke test spawning a worker and killing it at a named step in each of the three modes, asserting
the expected DBOS checkpoint state in each.

**Critical path, not polish** — this gates 9 of the 12 redeploy cases.

### 9 — `defineFlow`, the `step` wrapper, `runs.start`

`defineFlow` wrapper's first statement on the control pool:
`UPDATE hf_run SET status = 'running', version = $sha WHERE run_id = $1 AND current_workflow_id = DBOS.workflowID`
— zero rows means superseded, so return without running `fn` and without touching the run. Then run `fn`,
catch `Suspend` → `waiting`/`paused`, else `done`/`failed`; **every** status write carries the
`AND current_workflow_id = …` fence.

`step(name, fn, { key? })`: a checkpointed pre-step reads `hf_app_state.paused` and
`hf_run.current_workflow_id` in one query — paused → mark the run `paused` (fenced, control pool) and throw
`Suspend`; not current → `StaleAttempt`; else `DBOS.runStep(…, { retriesAllowed: false })` with `ctx.tx`
wired from DBOS context.

`runs.start(flow, input, { runId? })` as a control-plane operation: insert the `hf_run` row
(`attempt = 1`, `current_workflow_id = run_id`) and `enqueueInTransaction` in one tag-asserted transaction.

**Done:** a flow of N upserting steps killed after checkpoint and relaunched at the *same* SHA is recovered
by DBOS without re-running checkpointed steps; a superseded attempt's wrapper returns without running `fn`;
a paused app makes the next step `Suspend` and the run reach `paused`. (Redeploy case 3 proper lands at
chunk 10, when `llm.run` exists to count provider calls.)

### 10 — Minimum ledger slice *(pulled forward from Phase 2)*

`llm.run` gate transaction: `AppPaused` on a plain read; `P := to_char(now() AT TIME ZONE 'UTC','YYYY-MM')`;
lazy `INSERT INTO hf_budget_period … ON CONFLICT DO NOTHING` then `FOR UPDATE`; ledger insert
`ON CONFLICT (run_id, key) DO NOTHING` and read back; the five branches (`input_hash` mismatch →
`LedgerKeyCollision`; `ok` → return stored output; `error` → throw stored error; otherwise reserve); the
derived reservation
`SUM(estimated_cost_usd)` scoped to `status = 'started' AND period = $P AND l.workflow_id = r.current_workflow_id AND r.status = 'running'`
excluding this `(run_id, key)`; `BudgetExceeded`; `possible_double_charge` on a pre-existing row.
Provider call through `MockLanguageModel`. Completion transaction: `hf_budget_period` **first**, then the
ledger row. Plus minimal `actions.perform` on `hf_action_log` with the same `started`-row pattern,
`idempotency_key = ${run_id}:${key}`, and a stub channel.

**Lock order, enforced here and everywhere after:**
`hf_run` → `hf_budget_period` → (`hf_llm_call` | `hf_approval` | `hf_action_log`) → other app tables.

Out of scope for this chunk: provider registry, prompt files by content hash, Langfuse wiring, real
providers, `withClock`, the period-boundary cases, channels beyond the stub.

**Done: redeploy cases 2, 3 and 9.**

### 11 — `reconcile()`

Steps (1), (3), (4), (5); step (2) is deleted, not re-predicated. Drift read is a **plain `SELECT`** —
`reconcile()` never locks a budget row. A `running` run whose `current_workflow_id` has no DBOS row at all
is an invariant violation: logged at error, counted in `/api/status.anomalies`, enqueued anyway. Run once
after `launch`, then registered as a scheduled function every minute.

**Done: redeploy case 12** (50 runs each holding a `$1` dead-attempt row, budget `$10`, `llm` concurrency 4,
redeploy → reservation 0 immediately after the bumps, all 50 `done`, zero `BudgetExceeded`, 50 rows `ok`
with `possible_double_charge`, period `spent_usd = $5.00`) and **case 9's idempotency half** (three
`reconcile()` passes, one transition, `finished_at` unchanged).

### 12 — Minimum approvals slice *(pulled forward from Phase 2)*

`waitForApproval({ key, type, draft, … })`: step 1 inside `ctx.tx` inserts
`hf_approval (run_id, key, …) ON CONFLICT DO NOTHING` and reads back; decided → return the decision and
continue; pending → notify, set `notified_at`, mark the run `waiting`, `Suspend`.

`approvals.decide(…)` as a control-plane operation: `assertNotInWorkflow()`; one transaction that locks
**`hf_run` first** (`ORDER BY run_id FOR UPDATE`) then `hf_approval` (`ORDER BY id FOR UPDATE`); validate
the whole batch before writing; `decisionKey` replay returns the earlier result and writes nothing; per-row
conditional `UPDATE` with row count 1; per run the one bump path; `hf_audit` and `hf_activity` inserts are
**fatal**; commit through the tag-asserting helper; the `enqueueInTransaction` handle is discarded.

Out of scope for this chunk: batch edits with Zod validation, assignee rules, Telegram callbacks,
`reconcile()` expiry polish, the inbox UI.

**Done: redeploy cases 1 and 8**, including both kill-before-`COMMIT` halves (assert `attempt` unchanged,
no `dbos.workflow_status` row for the new id, approval still `pending`, and a retry with the same
`decisionKey` succeeds).

### 13 — `@hyperfixation/core` skeleton

`defineApp`, registries with duplicate-name errors, `/api/status` (read token) and `/api/status/{pause,resume}`
(write token) with `crypto.timingSafeEqual`. `pause` sets `hf_app_state.paused` and `llm`/`actions` queue
concurrency to 0; `resume` clears both and calls `reconcile()`. `records.archive()` as a control-plane
operation that throws `ControlPlaneInWorkflow` from any run.

**Done: redeploy case 4** (pause mid-loop, run reaches `paused` and the workflow SUCCESS within one step;
deploy a new SHA; resume; completion with zero extra provider calls); status-token tests; and
**`fence.test.ts` case (vii)'s `records.archive()` half**, which needs the function chunk 5 could not guard.

### 14 — Phase 1 exit assembly

Auth negatives and passkey enrolment through a software authenticator; the deep-import fixture fails `tsc`;
`pnpm turbo typecheck lint test` and `pnpm turbo api-extractor` green across core; all 12 redeploy cases and
all 7 fence cases green; `hf new demo-app --local && pnpm dev` signs in by emailed code, enrols a passkey,
and 404s on `/admin` for a member; `docker compose -f docker-compose.prod.yml config` validates.

---

## Parallel tracks

| Track | Contents | Can start | Must land by |
|---|---|---|---|
| **A — lint and contract mechanics** | Shared ESLint config (the `DBOS` property ban, `no-restricted-imports` on `@hyperfixation/*/src/*` and `dist/*`, the `src/flows/**` raw-handle hint), ban fixtures, API Extractor in all 8 packages with committed `etc/*.api.md`, deep-import `tsc` fixture | chunk 0 | 14 |
| **B — template and compose** | `Dockerfile` (`ARG SOURCE_COMMIT` → `ENV HF_BUILD_SHA`, `git rev-parse HEAD` fallback), both compose files with full `environment:` blocks, `mem_limit`, `stop_grace_period: 90s` on `worker`, `REQUIRED_ENV` + `compose-envs.test.ts`, CI workflows, dependabot, turbo generators, `components.json`, the two catch-all routes, `worker.ts`, `instrumentation.ts` | chunk 0 | 14 |
| **C — auth** | better-auth factory with `emailOTP` (`disableSignUp: true`), passkey, admin, organization; session-factor policy (`factor: 'code' \| 'passkey'`, code sessions confined to `/auth/*`, `/admin/*` needs `admin` and 404s otherwise); `requireSession({ factor, role })` in both layouts and every server action and route handler; bootstrap user; reset-second-factor action | chunk 2 | 14 |
| **D — admin** | Users resource generated from Drizzle metadata, reset-passkey action, guards | track C | 14 |
| **E — CLI** | `hf new --local` (giget copy, `__APP_NAME__`/`__DB_NAME__` substitution, `^[a-z][a-z0-9_]{0,62}$` validation), `hf migrate`, `hf bootstrap`, `hf check`, `hf gen`, `hf dev` (sets `HF_BUILD_SHA=dev-<timestamp>`) | track B for `new`; chunk 3 for `migrate` | 14 |

**Track A's done-check is redeploy case 5** (a fixture calling `DBOS.patch`, `DBOS.recv` or
`dbosClient.sendInTransaction` fails `eslint`) — the only gate case with no database dependency at all.

**Track C's done-check is `pnpm --filter @hyperfixation/auth test session-factor`** plus the auth negatives.

### Execution model (decided 2026-09-16): spine solo, tracks farmed out

**One session owns the serial spine start to finish. The five standing tracks go to background sessions.**

Chunks 4–5 (fence) and 6–7 (worker) *are* technically independent — chunk 5 needs a `DBOSClient` and the
`dbos` schema for `enqueueInTransaction` and the collision assert, but not `DBOS.launch` — and an earlier
draft forked them. **Don't.** They are the two subtlest pieces in Phase 1 and both touch the same
pool-and-worker boundary in `db` and `workflows`; the wall-clock saving is a chunk or two, and the cost is
splitting the fence mechanism across two heads at exactly the point where round 3 found four separate
escapes. One session holds both.

So the spine is strictly serial throughout: **0 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14**,
with chunk 1 alongside chunk 0 and chunk 8 splitting into 8a (after 6) and 8b (after 9).

The tracks parallelize nearly free — they touch almost entirely disjoint files from the spine. The one
shared surface is the migration journal, which track C (auth) appends to: **serialize migration-adding PRs
between track C and the spine**, or budget for a journal rebase on every collision.

### Merge friction to plan for

Tracks C and D add migrations while the spine adds migrations. The journal snapshot may only grow, so two
tracks appending concurrently will conflict on it every time. Either serialize migration-adding PRs or
budget for journal rebases.

---

## Gate case → chunk map

| Case | First passes at |
|---|---|
| `redeploy` 1 — approval across a redeploy with changed code | 12 |
| `redeploy` 2 — 1,000-record loop, killed before checkpoint | 10 |
| `redeploy` 3 — same-version crash recovery uses DBOS checkpoints | 10 |
| `redeploy` 4 — pause and resume across a redeploy | 13 |
| `redeploy` 5 — bans fail `eslint` | **Track A** |
| `redeploy` 6 — advisory-lock isolation | 6 |
| `redeploy` 7 — round-2 finding 1, process half and `in-tx` half | 8b (needs 4, 5, 7, 9) |
| `redeploy` 8 — reconcile bump then approval | 12 |
| `redeploy` 9 — orphaned reservation on a failed run | 10, idempotency half at 11 |
| `redeploy` 10 — grants, both directions | 3 |
| `redeploy` 11 — double SIGTERM, rejecting shutdown | 7 |
| `redeploy` 12 — the redeploy backlog | 11 |
| `fence` (i) — bump blocks on a held `ctx.tx` | 5 |
| `fence` (ii) — post-bump `ctx.tx` throws `StaleAttempt` | 5 |
| `fence` (iii) — two concurrent bumps, exactly one wins | 5 |
| `fence` (iv) — `WorkflowIdCollision` on a pre-inserted row | 5 |
| `fence` (v) — swallowed error → `CommitLost` | 5 |
| `fence` (vi) — step pool refuses six escape shapes | 4 |
| `fence` (vii) — `ControlPlaneInWorkflow` and `55P03` | 5 (`decide()` half), 13 (`records.archive` half) |
| `migration-policy` | 2 |
| `boot-checks` (E006 both ways) | 3 |
| `session-factor`, auth negatives | Track C |
| `compose-envs` | Track B |
| Worker isolation, deep-import `tsc` | 6, Track A |

## Decisions taken 2026-09-16

1. **Phase 1 pulls the ledger, actions and approvals slices forward** rather than splitting the gate across
   phases (Graham). The twelve-case redeploy suite stays one intact artifact. Recorded in the main plan's
   Phase 1 scope note.
2. **Budget periods are UTC calendar months** (Graham), closing round 3's open question. The stamp is
   `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')` and ships with Phase 2's gate; Phase 1 creates the table
   either way.
3. **Spine solo, tracks farmed out** — no fork at chunk 3. See the execution-model section.
4. **`fence.test.ts` case (vii) mocks `DBOS.isWithinWorkflow()` at chunk 5**, keeping the file's
   "no DBOS launch" contract. What's under test is `assertNotInWorkflow()`'s refusal, not DBOS's context
   machinery, so mocking the predicate tests exactly the guard and nothing else.

## Still open

Nothing blocking Phase 1. The plan's remaining open blocker — Hetzner bucket-scoped keys versus Cloudflare
R2 — is Phase 3 infrastructure and touches no Phase 1 chunk.
