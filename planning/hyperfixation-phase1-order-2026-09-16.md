# Hyperfixation Phase 1 — implementation order

**Date:** 2026-09-16. Derived from [hyperfixation-plan-2026-09-15.md](hyperfixation-plan-2026-09-15.md) as revised
after adversary rounds 2 and 3. **The design is fixed; this document only orders it.** Where this document
disagrees with the plan about *what* to build, the plan wins. Where it disagrees about *when*, this one does.

**Status updated 2026-09-17** against the tree at `6deac13`, and again **2026-09-18** for track A
(`257f4a4`). Every chunk, track and gate case below carries a
STATUS marker; a `(deviated)` marker is followed by a note naming what differs and the commit that decided it.
The markers are the point of this document now — the plan it derives from was written before any of it existed,
and drifted silently through chunks 11–13 until this pass.

**Marker scheme**

| Marker | Means |
|---|---|
| ✅ Done | built as specced |
| ✅ Done (deviated — see note) | built, but differs from this document's literal wording; the note says what and why |
| 🚧 In progress | partially built |
| ⬜ Not started | nothing built yet |

**Where the spine stands:** chunks 0–13 are ✅; chunk 14 is 🚧; tracks A, B and C are ✅ and tracks D and E
are ⬜. **All twelve redeploy cases are now written and committed** — case 5, the lint assertion, landed with
track A at 51bc37e; case 7 landed at e6bde42. The `session-factor` gate case landed with track C at a86660f;
`compose-envs` landed with track B in the sibling `hyperfixation-template` repo.

**What this pass verified, and what it did not.** Every marker below was set by reading the source and the
commit diffs — `packages/{db,ai,workflows,core}/src`, the migrations, and `git log -p` on the files in
question. **The suite was not run as part of this pass**, so "Done" here means *built and its gate case
committed*, not *observed green today*. Each chunk landed with its gate passing at the time; re-running
`pnpm turbo typecheck test` against a real pg17 is the check that would upgrade that claim, and chunk 14
requires it anyway.

## Three corrections this ordering pass produced

All three held. 1 ✅ Done — chunk 10 and chunk 12 shipped the two slices, and the twelve-case suite stayed one
artifact. 2 ✅ Done (deviated) — (i)–(vi) needed no launch as claimed, and (vii) took *both* escape hatches it
offered rather than one: a mocked predicate against stand-ins at chunk 5, and the real `records.archive()`
deferred to 13. 3 ✅ Done — the classifier was built first (eeb6d57, alongside chunk 0) and the interception
layer it settled has not moved since.

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

✅ Done (deviated) — the 8-package layout was scaffolded at 168315f; `testing`'s per-run database is the thin
wrapper over `db`'s migrator this section predicted, and there is no cycle. **Track A added a ninth package
(95c166c): `@hyperfixation/eslint-config`.** The eight *runtime* packages are still eight, and the reason for
the ninth is the plan's own wording — the config is "shared by core and template", so it has to be something
an app's `package.json` can depend on rather than a file at this repo's root. It joins the fixed version
group.

Two carve-outs, both settled:

- **`@hyperfixation/db`'s `exports` map stays a placeholder until chunk 4.** "No export resolves to the
  control pool" is contract surface, and which module holds the control pool is a chunk-4 decision.
  ✅ Done — settled at 57a1f5e, and the contract now holds of `@hyperfixation/workflows` too:
  `startWorker()` is the only way to obtain a control pool, and only its *types* are exported.
- **Scaffold all 8 packages including `@hyperfixation/ai`**, which now starts in Phase 1 rather than
  Phase 2 — it holds the minimum ledger slice (chunk 10). ✅ Done — and `ai` turned out to hold more than
  the slice: seven of the twelve redeploy cases live there, because the gate cases assert on ledger rows.

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

### 0 — Repo skeleton and toolchain — ✅ Done (deviated — see note)

pnpm workspaces, Turborepo, the 8 package directories with `package.json`/`tsconfig`/empty `src`,
`registry/`, changesets with one fixed version group, root vitest config, CI skeleton with a Postgres
service. `exports` maps are placeholders.

**Done:** `pnpm install && pnpm turbo typecheck` green across all 8 empty packages; a changesets `version`
dry run bumps all 8 in lockstep.

> **Deviation (168315f, 55f7f6e, 63f13b2):** "root vitest config" became a root config whose `projects` list
> the 8 per-package `vitest.config.ts` files, rather than a single root config or the separate workspace file
> the first pass wrote. Per-package configs are what let a chunk's gate run under
> `pnpm --filter @hyperfixation/<pkg> test`, which is how every done-check below is phrased.

### 1 — Statement classifier (spike) — ✅ Done

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

### 2 — Schema and migrations — ✅ Done

Drizzle definitions: the better-auth tables mapped to `hf_user`/`hf_session`(+`factor`)/`hf_account`/
`hf_verification`/`hf_passkey`/`hf_organization`/`hf_member`; `hf_app_state`; `hf_audit`; `hf_run`;
`hf_budget_period`; **and, pulled forward, `hf_llm_call` and `hf_action_log`** with the partial index
`(period, run_id, workflow_id) INCLUDE (estimated_cost_usd) WHERE status = 'started'` and `(period, status)`.
Generated migrations plus the journal.

**Done:** `migration-policy.test.ts` green including the `DROP COLUMN` and `CREATE FUNCTION` rejection
fixtures; journal snapshot test green (may only grow).

### 3 — Migrator, two roles, boot checks E001–E006 — ✅ Done (deviated — see note)

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

> **Deviation, found later (b0b6242, chunk 12):** the delete-guard trigger this chunk installed compared
> `record_id = OLD.id` — `text` against the record table's `bigint` identity — and the comparison error was
> latent until `hf_approval` became the first real referencing table to exercise it. Chunk 12 fixed it to
> `OLD.id::text`. A correctness bug in this chunk's shipped code, not a design change; the two db tests that
> had stood a hand-rolled table in for `hf_approval` now use the real one, which is why it surfaced at all.
> The lesson worth keeping: a trigger generated over a list of referencing tables is untested until one of
> those tables exists.

> **After chunk 3 the tree forks.** Chunks 4–5 (fence) and 6–7 (worker) are independent; see Parallelism.

### 4 — Pool factories and `ctx.tx` — ✅ Done

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

### 5 — `hf_run`, the one bump path, the control-plane transaction helper — ✅ Done (deviated — see note)

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

> **Deviation (57a1f5e, 7296766):** case (vii) drives **stand-ins** for the two named control-plane
> operations, not just a mocked `DBOS.isWithinWorkflow()`. Neither `approvals.decide()` (chunk 12) nor
> `records.archive()` (chunk 13) existed to be called here, and what (vii) asserts is
> `assertNotInWorkflow()`'s refusal and the 30 s `lock_timeout` bound — all either real operation has at
> this point. The real `records.archive()` half landed at chunk 13; see that chunk's note for where.

> **Milestone: `fence.test.ts` green.** The hardest mechanism in Phase 1 is proven and no worker has launched.
> **Reached** — `packages/db/src/fence.test.ts` covers cases (i)–(vii) and redeploy case 8's bump unit half.

### 6 — `startWorker()`, launch half — ✅ Done

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

### 7 — SIGTERM handler — ✅ Done

Exactly the round-3 verified shape: a **non-`async`** listener; module-level `shuttingDown` boolean that
logs and returns on a second delivery; `setTimeout(() => process.exit(1), 75_000).unref()` armed
**synchronously before any await**; then
`DBOS.shutdown({ workflowCompletionTimeoutMS: 60_000 }).then(() => process.exit(0), err => { log(err); process.exit(1) })`
with both arms explicit and nothing awaited. Lock connection never `.end()`ed.

**Done: redeploy case 11**, both halves — double SIGTERM 50 ms apart exits 0 within the drain with one
`shutdown` log line and no "Called end on pool more than once"; and a monkey-patched rejecting `shutdown`
with `@sentry/node`'s default `unhandledRejection` listener installed exits 1 within 1 s, not 75.

**Parallel with chunks 8–13** — it needs only chunk 6.

### 8 — Testing package: per-run database and crash harness — ✅ Done (deviated — see note)

**8a** (needs chunk 6): per-run database from a template, calling db's migrator and role provisioning;
`HF_BUILD_SHA = 'test-<uuid>'` per process; `MockLanguageModel` cassette; `spawnWorker({version, module, drainMs?})`;
the rule that any `UnfencedWrite` or `ControlPlaneInWorkflow` raised during a test fails it (the package
detects nothing — it makes the production refusal fatal).

**8b** (needs chunk 9): `killAt(stepKey, 'before-checkpoint' | 'after-checkpoint' | 'in-tx')`, where
`'in-tx'` parks the process inside an open `ctx.tx` after the fence statement.

**Done:** a smoke test spawning a worker and killing it at a named step in each of the three modes, asserting
the expected DBOS checkpoint state in each.

**Critical path, not polish** — this gates 9 of the 12 redeploy cases.

> **Deviation (6c0a241 for 8a; 785bb9a for 8b):** 8b shipped in the same commit as chunk 9 rather than as its
> own, because `killAt` has nothing to park in until `step()` exists. The three-mode smoke test lives in
> `packages/workflows/src/chunk9-smoke.test.ts`, not in `@hyperfixation/testing` — the harness is what
> `testing` owns; what the three modes *mean* is a `workflows` assertion. Redeploy case 7, which this chunk's
> harness was built to gate, landed at e6bde42 under chunk 14 — five chunks after the harness, which is the
> gap this document's 2026-09-17 pass found.

### 9 — `defineFlow`, the `step` wrapper, `runs.start` — ✅ Done

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

### 10 — Minimum ledger slice *(pulled forward from Phase 2)* — ✅ Done

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

**Done: redeploy cases 2, 3 and 9.** Green (753e923 for `llm.run`, a3ea82e for `actions.perform` and its stub
channel — the actions half shipped as its own commit, which is the only thing that differs from this entry).

### 11 — `reconcile()` — ✅ Done (deviated — see note)

Steps (1), (3), (4), (5); step (2) is deleted, not re-predicated. Drift read is a **plain `SELECT`** —
`reconcile()` never locks a budget row. A `running` run whose `current_workflow_id` has no DBOS row at all
is an invariant violation: logged at error, counted in `/api/status.anomalies`, enqueued anyway. Run once
after `launch`, then registered as a scheduled function every minute.

**Done: redeploy case 12** (50 runs each holding a `$1` dead-attempt row, budget `$10`, `llm` concurrency 4,
redeploy → reservation 0 immediately after the bumps, all 50 `done`, zero `BudgetExceeded`, 50 rows `ok`
with `possible_double_charge`, period `spent_usd = $5.00`) and **case 9's idempotency half** (three
`reconcile()` passes, one transition, `finished_at` unchanged). Committed — a359f06 for `reconcile()`, 060aaef
for case 12 and for moving cases 2 and 9 off their hand-rolled bump stand-in onto the real one.

> **Deviation 1 — step (5) is not in this chunk (a359f06 built 11 without it; 951bcf0 added it under 12).**
> This entry lists step (5) — expiring pending approvals through `decide()` — among chunk 11's steps, but
> step (5) *is* a call to `decide()` against `hf_approval`, and neither exists before chunk 12. The document
> is internally inconsistent here: chunk 12's entry is what introduces both. Chunk 11 shipped steps (1), (3)
> and (4) plus the drift read; step (5) landed after `decide()` did, in 951bcf0, as
> `EXPIRED_APPROVALS_STATEMENT` + `expireApprovals()` + `sweepDecisionKey(id) = 'sweep:<id>'`, one `decide()`
> call per expiring approval with `via: 'sweep'`. **Read step (5) as delivered in chunk 12, not 11.**
>
> **Deviation 2 — a CANCELLED attempt is re-attempted, not concluded (a359f06).** The plan groups
> `SUCCESS`/`ERROR`/`CANCELLED` under "mark the run accordingly". The implementation concludes only
> `SUCCESS`, `ERROR` and `MAX_RECOVERY_ATTEMPTS_EXCEEDED`; `CANCELLED` goes down the same re-attempt path as
> a dead version, with `reason: 'cancelled'`. There is no non-destructive terminal status to mark it with —
> `failed` is terminal and wrong here — and the state is *reconcile's own crash window*: `reconcile()` is
> the only caller of `cancelWorkflow` anywhere in the tree, and step (1) cancels and then bumps, so a pass
> that dies between the two leaves exactly a CANCELLED current attempt on a `running` run. The attempt
> cannot run, which is the same condition as a dead version, so it gets the same treatment. Concluding it
> would mark a live run dead because a reconcile pass was interrupted.

### 12 — Minimum approvals slice *(pulled forward from Phase 2)* — ✅ Done (deviated — see note)

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
`decisionKey` succeeds). Committed — b0b6242 for the slice, 951bcf0 for `reconcile()` step (5), 5b25f21 for the
two gate cases.

> **Deviation 1 — `decide()`'s real signature is `decide(pool, dbosClient, options)` (b0b6242).** This entry
> and the plan both write it as a bare `approvals.decide(…)`, which implies the function finds its own
> control pool and `DBOSClient`. Nothing owns them at chunk 12: `startWorker()` builds them for the worker
> and `getClient()` mints one for the web, and the thing that *holds* a pair is `defineApp`, which is
> chunk 13. So `decide()` takes them, exactly as `reconcile(pool, dbosClient, options)` does. `runsStart` is
> the same idea with the flow and its input positional:
> `runsStart(pool, dbosClient, flow, input, options?)`. `waitForApproval(options)` is the one that takes
> options alone — it runs inside a workflow and reads its handles from the run context, so there is nothing
> to pass it.
>
> **Deviation 2 — only the `hf_audit` insert is fatal; `hf_activity` does not exist.** The plan calls both
> inserts fatal inside `decide()`. `hf_activity` is a Phase 2 table: it appears in the plan's table list and
> nowhere in `packages/db/src/schema` or any migration. `decide()` writes one `hf_audit` row per decided
> approval, inside the same `controlPlaneTx` and with nothing catching. **Open item:** when `hf_activity`
> lands in Phase 2, its insert joins `decide()` under the same rule.
>
> **Deviation 3 — a new error the plan does not name: `ApprovalBatchRefused`.** A `decisionKey` that matches
> *some* of a batch's rows and not others refuses the whole batch rather than replaying the matching part.
> A batch is written atomically, so a mixed match cannot be this batch half-applied — it means a different
> batch already used the key, and the rows that do not carry it were never part of it. The error names every
> refused row and its reason at once. The same error carries the validate-before-write refusals (an id with
> no row, a row that is already decided).
>
> **Deviation 4 — `ApprovalRunMoved` retries the whole call, not part of it.** The read that chooses which
> runs to lock has to be unlocked (an approval names its run, not the other way round), so it can race a
> bump. When a locked approval's `run_id` is not one of the locked runs, `decide()` retries **once**, as a
> whole, in a fresh transaction. There is no partial retry to attempt: the tag-asserting commit helper has
> already rolled back and released the client on the way out. A second `ApprovalRunMoved` propagates.
>
> **Deviation 5 — a delete-guard correctness bug found and fixed here (b0b6242).** `hf_approval` is the
> first real table to exercise chunk 3's `BEFORE DELETE` guard, which surfaced that the generated trigger
> compared `record_id` (text) to `OLD.id` (bigint). Fixed to `OLD.id::text`. See chunk 3's note.
>
> **Maintenance note, not a deviation:** the three migration-count literals in
> `packages/db/src/migrate.test.ts` (lines 54, 67, 94) went `"2"` → `"3"` when `0002_approvals.sql` landed.
> They are hard-coded and every future migration will need them bumped. (`boot-checks.test.ts` carries no
> such literal — what changed there was its E002 fixture, which stopped standing a hand-rolled table in for
> `hf_approval` and started using the real one. `migrations-journal.baseline.json` is compared as a prefix,
> so it grows without needing a bump.)

### 13 — `@hyperfixation/core` skeleton — ✅ Done (deviated — see note)

`defineApp`, registries with duplicate-name errors, `/api/status` (read token) and `/api/status/{pause,resume}`
(write token) with `crypto.timingSafeEqual`. `pause` sets `hf_app_state.paused` and `llm`/`actions` queue
concurrency to 0; `resume` clears both and calls `reconcile()`. `records.archive()` as a control-plane
operation that throws `ControlPlaneInWorkflow` from any run.

**Done: redeploy case 4** (pause mid-loop, run reaches `paused` and the workflow SUCCESS within one step;
deploy a new SHA; resume; completion with zero extra provider calls); status-token tests; and
**`fence.test.ts` case (vii)'s `records.archive()` half**, which needs the function chunk 5 could not guard.
Committed — 496b903 for the package, 6deac13 for case 4.

> **Deviation 1 — `defineApp` holds the control plane, it does not build it (496b903).** This entry says
> only "`defineApp`, registries", which left the handle question open; the code had to decide it.
> `defineApp(options)` takes `{ name, applicationVersion?, flows?, sources?, resolvers?, scorers?,
> approvalTypes?, channels?, records? }` and constructs **no pool and no `DBOSClient`**. A separate
> `attach({ pool, client })` hands it a pair — `startWorker()`'s control pool in the worker, `getClient()`'s
> in the web — and every operation calls a `controlPlane(operation)` accessor first, which throws
> `AppNotAttached` naming the operation until then. `detach()` clears it. So the handles the bare chunk-11
> and chunk-12 functions took as their first two parameters are now held in one place, which is what
> chunk 12's deviation 1 was waiting for.
>
> Exact surface: seven registries (`flows`, `sources`, `resolvers`, `scorers`, `approvalTypes`, `channels`,
> and `records.types`, the last keyed by `recordType` rather than `name`), each a `createRegistry(kind)`
> that throws `DuplicateRegistration(kind, key)` on a repeat and `UnknownRegistration(kind, name, known)` on
> a miss — the duplicate-name error lives in the registry, not in `defineApp`. Then `runs.start`,
> `approvals.decide`, `reconcile`, `pause`, `resume`, `status()`, `statusHandler(request)` and
> `records.archive`. `applicationVersion` falls back to `HF_BUILD_SHA`; `reconcile()` and `resume()` throw
> `NoApplicationVersion` rather than reconcile under an undefined version.
>
> `pause`/`resume` are as specced, in mirrored order: `pause` sets `hf_app_state.paused` (plus its audit
> row) and then zeroes `llm` and `actions`; `resume` clears the flag, restores both to their registered
> concurrency, and then calls `reconcile()`. `resolve` is deliberately untouched by either half.
> `records.archive()` opens with `assertNotInWorkflow()` before any statement, cancels the record's pending
> approvals through `decide()` (one call each, `decisionKey = archive:<type>:<id>:<approvalId>`), then
> archives and audits in one `controlPlaneTx`. `/api/status` takes either token on `GET` and the write token
> on `POST …/{pause,resume}`, compared with `crypto.timingSafeEqual` over the sha256 digests.
>
> **Deviation 2 — `fence.test.ts` case (vii)'s `records.archive()` half is in
> `packages/core/src/records.test.ts`, not in `fence.test.ts`.** This entry puts it in `fence.test.ts`;
> it cannot go there. `fence.test.ts` lives in `@hyperfixation/db`, and `records.archive()` lives in
> `@hyperfixation/core`, which already depends on `db` — importing it back would be a package cycle. The
> test carries the same assertion against the real function (mock `DBOS.isWithinWorkflow() → true`, assert
> `ControlPlaneInWorkflow`, assert neither `pool.connect` nor `pool.query` was called, assert `archived_at`
> is still null) and names its origin in a comment. `fence.test.ts` keeps its two stand-in cases.
>
> **Deviation 3 — a pause/resume liveness race on redeploy, which the plan does not spec and nothing
> currently fixes.** `startWorker()`'s `DBOS.registerQueue` calls re-write every queue's row at its
> registered concurrency, so a worker booting into a paused app would reopen the queues `pause` had closed.
> The fix here is a read-then-write: `if (await appPaused(control.pool)) await
> setPausedQueueConcurrency(client, true)`. Those are two unsynchronised round trips, and an admin resume
> landing between them loses:
>
> 1. worker B's `registerQueue` restores `llm` 4 / `actions` 2;
> 2. worker B reads `paused` → `true`;
> 3. the admin resumes — flag cleared, concurrency restored, `reconcile()` bumps every parked run;
> 4. worker B's write lands → `llm` 0, `actions` 0.
>
> End state: `paused = false`, runs enqueued, queues pinned at 0 forever. Nothing self-heals it —
> `reconcile()` has no queue-concurrency step, `setPausedQueueConcurrency` does not read back, and
> `/api/status` classifies `health: 'degraded'` only on anomalies or budget drift, so it would report `ok`
> while showing `paused: false` alongside `globalConcurrency: 0` and a growing `enqueued`. The evidence is
> all on the endpoint; the diagnosis is a human reading two fields together. The plan requires only that the
> queue half be non-correctness-critical (the pause flag is what makes a paused app correct — every
> dispatched step suspends at its gate), and it is: this is a pure liveness stall. Redeploy case 4 does not
> reach it, because it awaits `workerB.ready()` — which includes the zeroing — before resuming.
>
> **Needs a decision before chunk 14**, one of: a `reconcile()` hygiene step that reconciles queue
> concurrency against `hf_app_state.paused` every minute; a read-after-write (or compare-and-set) in
> `startWorker()`; or a `degraded` signal for `paused = false` with a zeroed queue holding a backlog.
> Not invented here — the fix belongs to whoever takes chunk 14.

### 14 — Phase 1 exit assembly — 🚧 In progress

Auth negatives and passkey enrolment through a software authenticator; the deep-import fixture fails `tsc`;
`pnpm turbo typecheck lint test` and `pnpm turbo api-extractor` green across core; all 12 redeploy cases and
all 7 fence cases green; `hf new demo-app --local && pnpm dev` signs in by emailed code, enrols a passkey,
and 404s on `/admin` for a member; `docker compose -f docker-compose.prod.yml config` validates.

**What landed (e6bde42).** Redeploy case 7, both halves, in
`packages/workflows/src/redeploy-case-7.test.ts`; and `pnpm -w typecheck` plus `pnpm turbo test --force`
run green across all 8 packages — 38 test files, 222 tests, ~3 min against a real pg17. That is the first
time the whole suite has been *observed* green rather than inferred from each chunk's own gate, which is
what the 2026-09-17 pass said it could not claim.

**What is left, and why none of it is the spine's.** Every other bullet above belongs to a track: the auth
negatives and passkey enrolment to C, the deep-import fixture and `api-extractor` and `lint` to A, `hf new`
to E, `docker compose config` to B. **Track A closed its three (2026-09-18)** — the deep-import fixture fails
`tsc`, and `pnpm turbo typecheck lint test` and `pnpm turbo api-extractor` are green across core — and the
gate is now 12 of 12. **Track C closed the auth negatives (2026-09-18)**; the passkey-enrolment half of that
same bullet — *enrolment through a software authenticator* — is **not** closed, because nothing in this repo
drives WebAuthn yet and the template that would is track B's. **B, D and E have since closed too**
(2026-09-18), so every bullet above except the passkey half is struck: `hf new demo-app --local` builds an
app that migrates, bootstraps its admin, passes E001–E006 and serves `/w`, and its worker launches under
`HF_BUILD_SHA=dev-<timestamp>` — with one caveat on `pnpm dev` recorded in the track E note. What chunk 14
still cannot close on is **passkey enrolment through a software authenticator**, which no track owns, and
the pause/resume liveness race in "Still open".

> **Deviation 1 — worker A writes slower than the plan's 250 ms, and only worker A.** The plan's process
> half has A writing 60 rows 250 ms apart and taking `SIGTERM` at 6 s. Measured: `DBOS.shutdown()` waits
> `DRAIN_TIMEOUT_MS` (60 s) for a workflow running in this process, so a 15-second step simply *finishes*
> inside the drain — worker A exits having completed attempt 1, there is nothing for B to take over, and
> every assertion downstream of the handover holds vacuously or not at all. The state round-2 finding 1 is
> about is the one where the drain **abandons** the step with its bodies still writing, which needs the
> remaining work to outlast the drain. So `intervalMs` moved from the run's input to the worker's control
> and A uses 2 000 ms (~114 s left when the drain starts counting) while B uses the plan's 250 ms. The
> plan's numbers were written against the adversary's own harness, where `SHUTDOWN_RETURNED` came back in
> 3 002 ms because that harness had no DBOS in it. Cost: the process half takes ~86 s, almost all of it the
> 60 s drain it is asserting on.
>
> **Deviation 2 — the `in-tx` half's bump is driven from the test, not from a worker B.** The plan says
> "while B boots and reconciles". B cannot boot: A is parked inside an open `ctx.tx` and therefore alive and
> holding the advisory lock, which is the *first* half's whole assertion. The test calls
> `reconcile(control.pool, client, { applicationVersion: versionB })` itself, the same way redeploy case 12
> drives its bumps, and measures that the pass does not settle while A holds the transaction.
>
> **Deviation 3 — one production line changed: `acquireWorkerLock` now logs when it got the lock.**
> `WORKER_LOCK_STATEMENT` reads `now()` in the same statement as `pg_try_advisory_lock`, `WorkerLock`
> carries `acquiredAt`, and a `LOCK_ACQUIRED_MARKER` line carries it to the harness. Ordering the handover
> against a committed write needs one clock; A's write timestamps are the database's, and two process
> clocks cannot be compared at all.

---

## Parallel tracks

| Track | Contents | Can start | Must land by | Status |
|---|---|---|---|---|
| **A — lint and contract mechanics** | Shared ESLint config (the `DBOS` property ban, `no-restricted-imports` on `@hyperfixation/*/src/*` and `dist/*`, the `src/flows/**` raw-handle hint), ban fixtures, API Extractor in all 8 packages with committed `etc/*.api.md`, deep-import `tsc` fixture | chunk 0 | 14 | ✅ Done (deviated) — 95c166c, 51bc37e, 2bb9040, 257f4a4. See the track A note below |
| **B — template and compose** | `Dockerfile` (`ARG SOURCE_COMMIT` → `ENV HF_BUILD_SHA`, `git rev-parse HEAD` fallback), both compose files with full `environment:` blocks, `mem_limit`, `stop_grace_period: 90s` on `worker`, `REQUIRED_ENV` + `compose-envs.test.ts`, CI workflows, dependabot, turbo generators, `components.json`, the two catch-all routes, `worker.ts`, `instrumentation.ts` | chunk 0 | 14 | ✅ Done (deviated) — built in the sibling `hyperfixation-template` repo, 9c900e5..a1c7b30. See the track B note below |
| **C — auth** | better-auth factory with `emailOTP` (`disableSignUp: true`), passkey, admin, organization; session-factor policy (`factor: 'code' \| 'passkey'`, code sessions confined to `/auth/*`, `/admin/*` needs `admin` and 404s otherwise); `requireSession({ factor, role })` in both layouts and every server action and route handler; bootstrap user; reset-second-factor action | chunk 2 | 14 | ✅ Done (deviated) — 8004d96, a86660f, 08cc4c3, 2c6a3df, 6b3657c. See the track C note below |
| **D — admin** | Users resource generated from Drizzle metadata, reset-passkey action, guards | track C | 14 | ✅ Done (deviated) — fa14205, 66cfe45. See the track D note below |
| **E — CLI** | `hf new --local` (giget copy, `__APP_NAME__`/`__DB_NAME__` substitution, `^[a-z][a-z0-9_]{0,62}$` validation), `hf migrate`, `hf bootstrap`, `hf check`, `hf gen`, `hf dev` (sets `HF_BUILD_SHA=dev-<timestamp>`) | track B for `new`; chunk 3 for `migrate` | 14 | ✅ Done (deviated) — 5e58814, 1268d13, plus d1822f8 in the template repo. See the track E note below |

**All five tracks are done and the spine is at 13 of 14.** The execution model below assumed the tracks
would run alongside the spine from chunk 0; in practice the spine was built solo and the tracks were farmed
out after chunk 14 had already opened. What chunk 14 still waits on is no longer a track's code — it is
**passkey enrolment through a software authenticator**, which no track owns, and the pause/resume liveness
race. See "Still open" item 6.

**Track A's done-check is redeploy case 5** (a fixture calling `DBOS.patch`, `DBOS.recv` or
`dbosClient.sendInTransaction` fails `eslint`) — the only gate case with no database dependency at all.
✅ Done — `packages/workflows/src/redeploy-case-5.test.ts` (51bc37e).

> **Track A, what landed and where it differs.** Four commits: 95c166c the config, 51bc37e case 5,
> 2bb9040 the deep-import fixture, 257f4a4 API Extractor.
>
> **Deviation 1 — a ninth package, `@hyperfixation/eslint-config` (95c166c).** See the scaffolding section
> above. `turbo run lint` depends on `build` rather than `^build`, so a package can reach the config through
> its own `exports` map by self-reference; that is what lets all nine `eslint.config.js` files be the same
> two lines, and it is the shape the template will copy.
>
> **Deviation 2 — `sendInTransaction` is a `no-restricted-syntax` selector, not a `no-restricted-properties`
> entry.** The plan groups it with the `DBOS` property ban, but `no-restricted-properties` keys on the object
> *identifier*, and the gate case spells the call `dbosClient.sendInTransaction` — an instance. Keying on the
> member name catches both spellings. The six `DBOS` properties stay `no-restricted-properties`.
>
> **Deviation 3 — the deep-import patterns are `**`, and the flows override re-states them.** The plan writes
> `@hyperfixation/*/src/*` and `dist/*`; `src/**`/`dist/**` is what a nested path cannot slip through.
> `no-restricted-imports` is last-wins per file, so the `flows` override would otherwise *drop* the
> deep-import ban inside exactly the directory that most needs it — the config's own test asserts it does not.
>
> **Deviation 4 — the raw-handle hint is scoped to `**/flows/**`, not `src/flows/**`.** The same set for an
> app, and it also covers a fixture that lives outside a `src/`. It remains a hint: the config's test asserts
> round-3 finding 3's hole directly — a helper in `src/lib/` importing `@/db` is lint-legal — so nobody reads
> the rule as a backstop. The step pool is the enforcement.
>
> **Deviation 5 — two packages get a second API report.** API Extractor takes one entry point per run, and
> `db` and `testing` each publish two. `etc/db-migrator.api.md` and `etc/testing-worker.api.md` sit beside the
> main reports; leaving them out would mean half of `db`'s contract surface drifts unwatched.
>
> **Deviation 6 — CI runs `api-extractor` as its own step,** after `typecheck lint test`, so a red build says
> which it is: broken code, or a changed public API. Drift failure was verified by adding an export to `core`
> and watching `api-extractor run` exit non-zero.
>
> **Not in scope, deliberately.** The config carries the plan's three rules and nothing else — no
> `recommended` set, no formatting rules, no ban on long durable sleeps in flows (the plan names that ban in
> the run model but track A's contents do not list it). `@hyperfixation/eslint-config` has no API report of
> its own; it is a config, not a contract surface.

**Track C's done-check is `pnpm --filter @hyperfixation/auth test session-factor`** plus the auth negatives.
✅ Done — `packages/auth/src/session-factor.test.ts`, 18 tests, no database (a86660f). The negatives it
proves: a code-factor session is refused on `/`, `/runs`, `/api/runs` and `/settings` and sent to step up; a
server action that did not opt down to `factor: 'code'` refuses one too; a member with a passkey **404s** on
`/admin` and `/api/admin/users`; a stranger **404s** on `/admin/users` while the same stranger is redirected
to sign in on `/runs`, which is what shows the 404 is the admin area's doing and not a blanket refusal; an
*admin* holding only a code-factor session 404s rather than being offered a step-up; a banned user with a
live passkey session is refused both ways; and `requireSession` throws rather than return a session whose
refusal a host declined to divert. Four more files carry the rest against a real database — the factory end
to end, `bootstrapAdmin`, `resetSecondFactor`, and the exports contract — 38 tests in all.

> **Track C, what landed and where it differs.** Five commits: 8004d96 `hf_invitation`, a86660f the policy
> and `requireSession`, 08cc4c3 the factory, 2c6a3df the bootstrap user, 6b3657c the reset action.
>
> **Deviation 1 — track C *did* write a migration, and the entry above saying it would not was wrong.**
> Chunk 2 put seven better-auth tables in `0000_core_schema.sql`. better-auth's `organization` plugin writes
> an **eighth** model, `invitation`, and the drizzle adapter's schema check refuses to initialise the whole
> instance when a model it writes has no table — at `createAuth`, not at the first invitation. So
> `0003_auth_invitation.sql` adds `hf_invitation` with better-auth's own columns (read off `getAuthTables()`,
> not guessed). Nothing in Phase 1 sends an invitation — an invitation ends in a sign-up and there is no
> sign-up — so the factory sets `invitationLimit: 0`; the table exists so that turning them on later is a
> config change. The three hard-coded counts in `migrate.test.ts` went 3 → 4, exactly as Still open item 5
> predicted the first track-C migration would force.
>
> **Deviation 2 — the role test runs before the factor test, and a role check 404s on *every* refusal.**
> The plan says `/admin/*` needs `admin` and 404s otherwise. The order matters and it does not say which:
> putting the factor test first would step-up-redirect an admin who holds only an emailed code, and that
> redirect confirms the admin area exists to anyone who can read an inbox. So any check that names a role
> answers `not-found` for no-session, banned, missing-role *and* code-factor alike.
>
> **Deviation 3 — `requireSession` is bound by a factory, `createSessionGuard`.** The plan writes it as a
> bare `requireSession({ factor, role })`. This package cannot depend on `next`, and the guard needs three
> things an app owns: how to read the current session, `redirect()`, and `notFound()`. So the app binds them
> once and every call site sees the plan's signature. `pathname` joins the options and is **optional**, which
> is the strict case: a server action states its own bar and defaults to passkey.
>
> **Deviation 4 — `upgradeSessionFactor`, a promotion path the plan does not name.** The factor is stamped
> from the endpoint that minted the session, and only `/passkey/verify-authentication` mints `passkey`. That
> leaves the user who signs in by code and enrols a passkey holding a code-factor session on the page they
> enrolled from. `upgradeSessionFactor(pool, token)` promotes that one session in place, called by the
> enrolment action after registration succeeds. It grants nothing an immediate passkey sign-in would not.
>
> **Deviation 5 — `resetSecondFactor` revokes *all* of the user's sessions, not just the passkey ones.**
> A code-factor session is confined to `/auth/*`, and `/auth/*` is where enrolment lives: leaving one alive
> lets whoever holds the lost device's session enrol a fresh authenticator and promote straight back.
>
> **Deviation 6 — the bootstrap user refuses more than it grants.** `bootstrapAdmin(pool, …)` is a function
> `hf bootstrap` calls, never an endpoint. It refuses the moment any user holds `admin`; with
> `HF_BOOTSTRAP_EMAIL` set only that address may be bootstrapped; with it unset only the first user of an
> empty `hf_user` may be. Unset *and* a populated table is refused rather than guessed at. The whole
> check-then-write is under `pg_advisory_xact_lock`, because the counts it reads are otherwise unlocked.
>
> **Deviation 7 — `etc/auth.api.md` is ~3,600 lines.** `createAuth`'s return type has to be inferred:
> better-auth's `Auth` is generic in the exact option object, so `ReturnType<typeof betterAuth>` is not
> assignable to itself and every plugin endpoint disappears from `auth.api`. `zod` and
> `@simplewebauthn/server` are direct dependencies for the same reason (TS2742). The report is honest about
> the surface this package publishes; it will churn on a better-auth upgrade. See Still open item 7.
>
> **Not in scope, deliberately.** No passkey enrolment through a software authenticator — nothing here
> drives WebAuthn, and the app that would is track B's template. No `next` dependency, no UI, no
> `packages/admin` (track D). `emailAndPassword` is left off entirely rather than configured off.

> **Track B note.** Built in the sibling repo `/Users/grahamlutz/Code/hyperfixation-template`
> (9c900e5..a1c7b30, 9 commits), not in `hyperfixation-core` — this is a per-app template, not an
> hyperfixation-core package, so it lives in its own checkout with its own toolchain.
>
> `REQUIRED_ENV` (14 vars, `src/env.ts`): `HF_PROCESS`, `HF_BUILD_SHA`, `DATABASE_URL`,
> `MIGRATOR_DATABASE_URL`, `APP_URL`, `BETTER_AUTH_SECRET`, `SMTP_URL`, `EMAIL_FROM`, `SENTRY_DSN`,
> `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` —
> derived by grepping core's actual env reads, not guessed. Deliberately excluded: the status-route tokens
> (`hf_app_state` columns, not deploy config) and `S3_*` (Phase 3's, read by no Phase 1 code).
>
> **Deviation — the unpublished-package bridge.** `pnpm-workspace.yaml` overrides `@hyperfixation/*` to
> `link:../hyperfixation/packages/<name>`, plus (found the hard way) `drizzle-orm` and `@dbos-inc/dbos-sdk`
> to core's own copies — two pnpm stores otherwise give TypeScript two incompatible identities for the same
> type (`db.execute(sql…)` fails to typecheck: "separate declarations of a private property"). The entire
> fix, once packages are actually published: delete `pnpm-workspace.yaml`.
>
> **Deviation — `next build` needs `--webpack`, not Turbopack, until publishing.** Turbopack can't resolve
> a `link:`-ed package outside the project root; verified the app itself is sound by building with
> `npx next build --webpack` (compiles, typechecks, emits all four routes). `package.json` keeps plain
> `next build`, correct once published. CI's build step can't pass until then — same as `pnpm install`, so
> nothing new is broken.
>
> **Deviation — `worker.ts`/`migrate.ts` run via `tsx`, no `dist/`.** A compiled second `tsc` project forced
> `.js` extensions on relative imports, which Turbopack can't resolve back to `.ts` — so `app/` importing
> `src/` broke. Extensionless imports + `node --import tsx` instead, matching how `@hyperfixation/testing`'s
> own harness spawns workers.
>
> **Deviation — `app/api/status/[[...route]]/route.ts`, not the plan's literal `route.ts`.** Matches core's
> own `status-route.ts`, which handles `/status`, `/status/pause`, `/status/resume` as one catch-all; a plain
> `route.ts` would only ever serve one of the three.
>
> **Deviation — `docker-entrypoint.sh`, a file not in the plan's layout.** `ENV HF_BUILD_SHA=$SOURCE_COMMIT`
> alone can't carry the `git rev-parse HEAD` fallback the doc requires (Docker can't compute an `ENV` from a
> `RUN`). The builder writes the resolved sha to `/app/.hf-build-sha`; the entrypoint fills `HF_BUILD_SHA`
> from it only when unset. `.git` is deliberately not in `.dockerignore` for this reason.
>
> **Deviation — ships a demo flow and `demo_note` table**, ahead of the plan's Phase 5 placement — otherwise
> `flow-restart.test.ts` passes vacuously over zero flows, and `.claude/skills/replace-demo/` presumes a demo
> exists. The test asserts `flows.length > 0` so the vacuum can't return.
>
> **Not done, correctly left open.** The two catch-all routes don't call `requireSession()` yet — track C's
> auth landed mid-session; the routes' TODOs now name the real guard (`createSessionGuard()`,
> `AccessRefused`, `ADMIN_ROLE`, a1c7b30) but wiring it needs sign-in/step-up routes this template doesn't
> have yet. This is now unblocked and is the obvious next piece.

**Track D's done-check is `pnpm --filter @hyperfixation/admin test`.** ✅ Done — 29 tests in five files,
three of them against a real database. The negatives they prove: a member holding a passkey, a stranger, an
admin holding only an emailed code and a banned admin all get the same `not-found` from
`AdminRouter.route()`, on `/admin` and on `/admin/users` alike; the guard runs before the path is resolved,
so `/admin/widgets` refuses identically; `actions.resetSecondFactor` refuses a member and deletes nothing;
and a declared list field the table does not have throws at construction rather than at render.

> **Track D, what landed and where it differs.** Two commits: fa14205 the resource generator and the users
> resource, 66cfe45 the router, the guard and the reset action's exposure.
>
> **Deviation 1 — "generated from Drizzle metadata" is two thirds generated and one third declared, checked.**
> `resourceFromTable` reads every field, its SQL column, nullability, default, primary key and uniqueness out
> of `getTableColumns`/`getTableName`, and derives each label from the field name, so a column added to
> `hf_user` reaches the admin with no edit here. What the metadata cannot know stays declared: the resource's
> name, which fields the list shows and in what order, and which actions it offers. That declaration is the
> one part a rename can rot, so it is validated against the metadata at construction (`UnknownAdminField`).
> Calling the whole thing "generated" would overstate it.
>
> **Deviation 2 — the guard runs before the path is resolved, and an unserved path answers like a refused
> one.** Resolving first would let `/admin/widgets` and `/admin/users` answer a stranger differently, and the
> difference between those two answers is a map of the admin area. `route()` therefore calls
> `requireSession({ factor: 'passkey', role: 'admin' })` on every route including the index, and states the
> bar itself rather than leaning on the route's `pathname` — an app that mounts the admin elsewhere still
> gets the admin bar. An unserved path returns `undefined` for the host to answer with its own not-found.
>
> **Deviation 3 — the admin router renders nothing and returns a route descriptor.** The plan calls it a
> "router"; this package cannot depend on `next` for the same reason auth cannot, so `route()` answers with
> `{ kind: 'index' | 'list' | 'detail' }` and the template's `(admin)/admin/[[...path]]` page renders it.
> Same division core already makes between `statusRouteOf` and the page that serves it. Reading rows is
> deliberately not here either: Phase 1's contents are the resource, the action and the guards.
>
> **Deviation 4 — admin resources are a registry, which the plan does not say they are.** Core's registry
> list names sources, records, resolvers, scorers, flows, approval types, actions, pages and schedules, not
> admin resources. `createAdminRouter` uses `createRegistry` from `@hyperfixation/core` anyway: a resource
> name is what a stored row and a bookmarked URL point at, which is the same argument every other registry
> is built on, and Phase 2's resources for the machinery tables need a shape to register in. The cost is a
> `@hyperfixation/core` dependency on `admin`, which the web container already loads for `defineApp`.
>
> **Deviation 5 — `etc/admin.api.md` is 135 lines, and that is on purpose.** Still open item 7 predicted this
> package would add auth's kind of surface. It did not: every export is named explicitly in `index.ts`,
> nothing is re-exported wholesale, and `usersResource` is annotated `AdminResource` rather than left to
> inference, so a `hf_user` column change moves no line of the report. Nothing here has an option-generic
> return type to infer, which is the whole of why auth's is ~3,600 lines and this one is reviewable.
>
> **Deviation 6 — adding this package churned `db.api.md` and `auth.api.md` anyway, for a reason item 7 did
> not predict** (270fc6b). `admin` depends on `@hyperfixation/auth` and on `drizzle-orm` directly; better-auth
> carries `kysely`, which drizzle-orm declares as an optional peer, so drizzle-orm now resolves to a different
> identity workspace-wide and `tsc` emits some inferred unions in a different member order. Six lines across
> the two reports, all reordering, no semantic change, and the new order is the source order. Worth knowing
> because it is the failure mode item 7 is really about: the report is a file a *dependency graph* change can
> touch, not only an API change, and `pnpm -w api-extractor` goes red until someone regenerates it.
>
> **Not in scope, deliberately.** No reads — the router resolves a route, it does not query. No UI, no
> `next` dependency, no label override for a generated label an app dislikes, no resource beyond `users`
> (the machinery-table resources are core's, Phase 2's). The template's admin page still renders its own
> placeholder: wiring it is track B's file and track E's session to touch, not this one's.

**Track E's done-check is `pnpm --filter @hyperfixation/cli test`.** ✅ Done — 45 tests in nine files,
four of them against a real database. What they prove: `hf new demo-app` leaves **no** placeholder anywhere
in a copy of the real template checkout and writes `.env` from the substituted `.env.example`; a source with
no marker, a target that exists, a name that is not an identifier and a missing `--local` are each refused
before anything is written; `provisionLocalRoles` creates a role that can read the tables the migrator
already made and is idempotent on a second pass; `hf bootstrap` grants the first admin as the application
role and the second run is refused; and `hf check` names a declared-but-absent var, a pending app migration,
and the fact that it could not read the registry — rather than passing E001–E003 over an empty list.

> **Track E, what landed and where it differs.** Two commits here — 5e58814 `hf new` and the app resolution
> the other five commands share, 1268d13 the five commands and the `hf` binary — plus d1822f8 in
> `hyperfixation-template`.
>
> **Deviation 1 — both placeholders are the underscored name, and the template's marker now says so**
> (d1822f8). The plan validates `db_name` against `^[a-z][a-z0-9_]{0,62}$` and spells its own exit bar
> `hf new demo-app --local`; those cannot both be true of one string. Track B's marker resolved half of it
> — the name may carry a hyphen, `__DB_NAME__` underscores it — and left `__APP_NAME__` unstated, which
> would have written `name: "demo-app"` into `src/hyperfixation.ts`, straight into `roleNames()`, which
> refuses a hyphen: the app would not have migrated at all. So the **directory** is what was typed and
> **both placeholders** are the underscored form. `hf_<app>` is then both the database name and the
> application role, which is the identity `provisionRoles` already assumes.
>
> **Deviation 2 — giget's semantics, not giget.** Phase 1's source is a local sibling checkout; giget
> resolves `gh:`/`gitlab:`/tarball URLs and addresses no local directory. What is kept is the part that
> matters — assert the `.hyperfixation-template` marker on the source, refuse a target that exists, delete
> the marker from the copy. The remote fetch is Phase 3's, beside the provisioning that is the rest of a
> cloud `hf new`.
>
> **Deviation 3 — `hf migrate` shells out to the app's own `migrate.ts` rather than calling `migrate()`.**
> The record tables and the app migrations directory come from the app's registry and `migrate.ts` is what
> reads them; it is also the file the deployed one-shot `migrate` service runs, so a laptop and a deploy
> cannot drift. The CLI's own half is the application role — which `provisionRoles()` cannot create here,
> because it records default privileges `FOR ROLE hf_<app>_migrator` while a local migrator is the compose
> superuser, so the application role would end up unable to read what the migrator made.
> `provisionLocalRoles` records them for whoever is connected and also grants on already-existing objects.
> It therefore needs a connection that can create a role; `--skip-roles` is the cloud path.
>
> **Deviation 4 — `hf check`'s env contract is `.env.example`, and "missing" means absent, not empty.**
> Track B's `compose-envs.test.ts` already pins that file, both compose blocks and `REQUIRED_ENV` to each
> other, so reading it means an app that adds a var of its own is checked for it too — and duplicating
> `REQUIRED_ENV` here would be a second list to keep in step. The template ships six vars empty on purpose,
> so an empty value is a declared local state and only an absent name is a gap.
>
> **Deviation 5 — E001–E003 need the registry, so `hf check` imports it in a child under the app's `tsx`.**
> There is no static way to learn the record tables. A probe that fails is reported as a finding naming the
> checks it left empty, rather than letting `hf check` report green over an empty list.
>
> **Deviation 6 — `hf gen` runs `@turbo/gen`'s installed bin, not `turbo gen`.** `turbo gen` re-fetches
> `@turbo/gen` through `pnpm dlx` even when the app already depends on it, and that second copy installs
> outside the app's `pnpm-workspace.yaml` — so pnpm 12 refuses `esbuild`'s build script that the app's own
> `allowBuilds` had permitted. Verified: the template's own `pnpm gen` fails this way in a freshly created
> app, and `pnpm exec gen run record --args note` succeeds, writing the schema file, the export and the
> registration.
>
> **How far the exit-bar proof got, exactly.** `hf new demo-app --local` against the real template, then
> `pnpm install`, `hf dev --compose-only`, `hf migrate`, `hf bootstrap`, `hf check`, `hf gen` — all green
> against a real pg17 in the app's own dev compose. `hf migrate` reported
> `dbosSchemaGranted: true`, the app migration applied and a delete guard on `demo_note`; `hf check` printed
> "env, migrations and E001-E006 all clear" with the registry probe succeeding; a worker started with
> `HF_BUILD_SHA=dev-<timestamp>` passed E001–E006, launched DBOS, registered all three queues and ran a
> `reconcile()` pass. **`pnpm dev` itself does not compile**, for track B's already-recorded reason:
> Turbopack cannot resolve a `link:`-ed package outside the project root, and Next 16's `dev` is Turbopack
> by default. `next dev --webpack` in the same app serves `/w` 200 and `/api/status` 401 (no token), which
> is the app working. The one-word fix — `"dev": "next dev --webpack"` — was **not** made, because track B
> deliberately keeps the published-correct spelling in `package.json` and this is the same publishing
> artifact as CI's build step; deleting `pnpm-workspace.yaml` at the first publish closes both.
>
> **Not in scope, deliberately.** No cloud `hf new`: `--local` is refused into an error rather than
> ignored, because a half-provisioned app is worse than none. No `hf doctor`, no `hf restore-check` — both
> Phase 3's. `hf dev` starts the web and not a worker, matching `pnpm dev`; note that the template's
> `worker.ts` does not load `.env` on its own, so `pnpm worker` needs the environment supplied, which is
> track B's file to decide about.

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

**Did not materialise, but not for the reason given.** Nothing raced the spine, because the spine was
finished before any track ran. The second reason — chunk 2 put all seven better-auth tables into
`0000_core_schema.sql`, so track C has no migration of its own — was **wrong**: the `organization` plugin
needs an eighth table and track C added `0003_auth_invitation`. It appended to a journal nobody else was
touching, so the friction this section predicted still did not happen. The spine added two migrations of its
own (`0001_llm_call_reservation_index`, `0002_approvals`) with no conflict. The journal baseline is compared
as a **prefix**
(`migrations-journal.baseline.json`), which is what makes "may only grow" cheap to satisfy; the thing that
actually costs a touch per migration is the hard-coded count in `migrate.test.ts` — see chunk 12's
maintenance note.

---

## Gate case → chunk map

| Case | First passes at | Status | Lives in |
|---|---|---|---|
| `redeploy` 1 — approval across a redeploy with changed code | 12 | ✅ Done | `packages/ai/src/redeploy-case-1.test.ts` |
| `redeploy` 2 — 1,000-record loop, killed before checkpoint | 10 | ✅ Done | `packages/ai/src/redeploy-case-2.test.ts` |
| `redeploy` 3 — same-version crash recovery uses DBOS checkpoints | 10 | ✅ Done | `packages/ai/src/redeploy-case-3.test.ts` |
| `redeploy` 4 — pause and resume across a redeploy | 13 | ✅ Done | `packages/ai/src/redeploy-case-4.test.ts` |
| `redeploy` 5 — bans fail `eslint` | **Track A** | ✅ Done | `packages/workflows/src/redeploy-case-5.test.ts`, over `fixtures/banned-primitives.ts` and `fixtures/flows/raw-handle.ts` |
| `redeploy` 6 — advisory-lock isolation | 6 | ✅ Done | `packages/workflows/src/redeploy-case-6.test.ts` |
| `redeploy` 7 — round-2 finding 1, process half and `in-tx` half | 8b (needs 4, 5, 7, 9); written at 14 | ✅ Done (deviated) | `packages/workflows/src/redeploy-case-7.test.ts`, over `test-support/writer-flow.ts`. See chunk 14's deviations 1–3 |
| `redeploy` 8 — reconcile bump then approval | 12 | ✅ Done | `packages/ai/src/redeploy-case-8.test.ts`; the bump unit half in `fence.test.ts` |
| `redeploy` 9 — orphaned reservation on a failed run | 10, idempotency half at 11 | ✅ Done | `packages/ai/src/redeploy-case-9.test.ts` |
| `redeploy` 10 — grants, both directions | 3 | ✅ Done | `packages/db/src/redeploy-case-10.test.ts`; launch half in `packages/workflows/src/redeploy-case-10-launch.test.ts` |
| `redeploy` 11 — double SIGTERM, rejecting shutdown | 7 | ✅ Done | `packages/workflows/src/redeploy-case-11-sigterm.test.ts` |
| `redeploy` 12 — the redeploy backlog | 11 | ✅ Done | `packages/ai/src/redeploy-case-12.test.ts` |
| `fence` (i) — bump blocks on a held `ctx.tx` | 5 | ✅ Done | `packages/db/src/fence.test.ts` |
| `fence` (ii) — post-bump `ctx.tx` throws `StaleAttempt` | 5 | ✅ Done | `packages/db/src/fence.test.ts` |
| `fence` (iii) — two concurrent bumps, exactly one wins | 5 | ✅ Done | `packages/db/src/fence.test.ts` |
| `fence` (iv) — `WorkflowIdCollision` on a pre-inserted row | 5 | ✅ Done | `packages/db/src/fence.test.ts` |
| `fence` (v) — swallowed error → `CommitLost` | 5 | ✅ Done | `packages/db/src/fence.test.ts` |
| `fence` (vi) — step pool refuses six escape shapes | 4 | ✅ Done | `packages/db/src/fence.test.ts` |
| `fence` (vii) — `ControlPlaneInWorkflow` and `55P03` | 5 (stand-ins), 13 (`records.archive` half) | ✅ Done (deviated) | `packages/db/src/fence.test.ts` for the stand-ins and the `55P03` bound; **`packages/core/src/records.test.ts`** for the real `records.archive()` half — `db` cannot import `core` without a cycle. See chunk 13's note |
| `migration-policy` | 2 | ✅ Done | `packages/db/src/migration-policy.test.ts` |
| `boot-checks` (E006 both ways) | 3 | ✅ Done | `packages/db/src/boot-checks.test.ts` |
| `session-factor`, auth negatives | Track C | ✅ Done | `packages/auth/src/session-factor.test.ts` (no database); the database-backed halves in `auth-flow.test.ts`, `bootstrap.test.ts` and `reset-second-factor.test.ts` |
| `compose-envs` | Track B | ✅ Done | `hyperfixation-template` repo, `tests/compose-envs.test.ts` (11 tests) |
| Worker isolation, deep-import `tsc` | 6, Track A | ✅ Done | `packages/workflows/src/worker-isolation.test.ts`; the deep-import fixture in `packages/workflows/src/deep-import.test.ts` over `fixtures/deep-import/` |

**All twelve redeploy cases and all seven fence cases are written, committed and observed green together**
(`npx turbo run test --force`, 2026-09-18: 41 files, 243 tests, 3m12s — the 2026-09-17 run's 38 files and 222
tests plus track A's three files). `pnpm -w typecheck`, `pnpm -w lint` and `pnpm -w api-extractor` are green
in the same tree. **With tracks D and E in, the same run is 60 files and 356 tests in 3m14s**, all nine
packages green (track E, 2026-09-18). One caution for whoever reads a red run: `redeploy-case-1` failed both
of its cases once under full-suite load and passed alone and on the next full run, so that file is
load-sensitive rather than flaky-by-construction — re-run it on its own before chasing it.

## Decisions taken 2026-09-16

1. **Phase 1 pulls the ledger, actions and approvals slices forward** rather than splitting the gate across
   phases (Graham). The twelve-case redeploy suite stays one intact artifact. Recorded in the main plan's
   Phase 1 scope note.
2. **Budget periods are UTC calendar months** (Graham), closing round 3's open question. The stamp is
   `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')` and ships with Phase 2's gate; Phase 1 creates the table
   either way.
3. **Spine solo, tracks farmed out** — no fork at chunk 3. See the execution-model section.
   ✅ Done (deviated) — the spine half held exactly: chunks 0–13 were built serially by one head, in the
   stated order, with no fork at chunk 3. The tracks half happened late rather than alongside: track A was
   farmed out on 2026-09-18, after chunk 14 had already opened, and B–E have not been. Farming A out after
   the spine cost nothing — it touched no file the spine owns except each package's `scripts` block — which
   is evidence for the "nearly free" claim, just not for the timing.
4. **`fence.test.ts` case (vii) mocks `DBOS.isWithinWorkflow()` at chunk 5**, keeping the file's
   "no DBOS launch" contract. What's under test is `assertNotInWorkflow()`'s refusal, not DBOS's context
   machinery, so mocking the predicate tests exactly the guard and nothing else.
   ✅ Done (deviated) — the mock is there, and so is a second thing this decision did not say: case (vii)
   drives **stand-ins** for `decide()` and `records.archive()`, because neither existed at chunk 5. The real
   `records.archive()` assertion landed at chunk 13, in `packages/core/src/records.test.ts`.

## Still open

**Swept 2026-09-17 against chunks 11–13.** The one item this section carried is unchanged; what chunks 11–13
added is below it.

1. ⬜ **Unchanged, not blocking.** The plan's remaining open blocker — Hetzner bucket-scoped keys versus
   Cloudflare R2 — is Phase 3 infrastructure and touches no Phase 1 chunk.
2. 🚧 **The pause/resume liveness race on redeploy** (chunk 13). Queues can end up pinned at 0 with the app
   reporting unpaused and healthy; nothing self-heals it and the plan specs no fix. Needs a decision — a
   `reconcile()` hygiene step, a read-after-write in `startWorker()`, or a `degraded` signal. See chunk 13's
   note. **The one open item with a correctness-adjacent smell.** Still undecided after chunk 14's first
   pass: it is a design choice among three shapes, not an implementation gap, and case 7 gave it no new
   evidence either way. It has to be settled before chunk 14 closes.
3. ⬜ **`hf_activity`'s insert in `decide()`** (chunk 12). The plan makes it fatal alongside `hf_audit`;
   the table is Phase 2's and does not exist. Wire it under the same rule when it lands.
4. ✅ **Redeploy case 5 is closed** (51bc37e, track A), and with it the twelve-case suite. **Case 7 is
   closed** too (e6bde42, chunk 14).
5. 🔁 **Migration-count literals** (chunk 12). `packages/db/src/migrate.test.ts` hard-codes the core
   migration count in three places; every future migration bumps them. Maintenance, not a defect — and it
   **was** hit by the first track-C migration, exactly as predicted: `0003_auth_invitation` took all three
   from `"3"` to `"4"` (8004d96). Phase 2's first migration will take them to `"5"`.
6. 🚧 **Every track is done; chunk 14 waits on one bullet no track owned.** A, B, C, D and E have all
   landed, so six of its bullets are struck: the deep-import fixture fails `tsc`, `lint` is green across
   core, `api-extractor` is green against committed reports, the auth negatives are proven,
   `docker compose -f docker-compose.prod.yml config` validates, and `hf new demo-app --local` now produces
   an app that installs, migrates, bootstraps its admin, passes E001–E006, launches a worker under
   `HF_BUILD_SHA=dev-<timestamp>` and serves `/w` (E, 5e58814 and 1268d13). What remains is **passkey
   enrolment through a software authenticator** — track C's subject but not its code, since nothing in
   either repo drives WebAuthn; the template (B) has the routes but not the sign-in/enrolment pages, and
   neither D nor E touched them. It needs an explicit home before chunk 14 closes, and it is now the *only*
   piece of Phase 1 nobody is building. Two smaller things travel with it, both track B's file: `pnpm dev`
   runs Turbopack, which cannot resolve the `link:`-ed packages (`next dev --webpack` works, and publishing
   closes it), and `worker.ts` does not load `.env`, so a local `pnpm worker` needs the environment
   supplied. The spine still has nothing left to build.
7. 🔁 **The API reports are now a file every API-changing PR touches.** `etc/*.api.md` is committed and CI
   fails on drift, which is the point. Track C hit it first and hard: `etc/auth.api.md` went from an empty
   placeholder to ~3,600 lines, because `createAuth`'s return type has to be inferred out of better-auth's
   option-generic `Auth` and the report names every plugin endpoint it carries. A better-auth version bump
   will produce a large, unreviewable diff in that one file. **Worth a decision before the template ships**:
   either accept the churn, or narrow the published surface to the handful of `auth.api` endpoints the
   template actually calls. **Track D did not repeat it**: `etc/admin.api.md` is 135 lines (66cfe45), because
   every export is named explicitly, nothing is re-exported wholesale, `usersResource` is annotated rather
   than inferred, and nothing in `admin` has an option-generic return type to infer. So the *size* problem is
   narrower than it looked — it is `auth`'s alone, and specifically `createAuth`'s. But track D found a second
   shape of the same cost: adding `admin` moved six lines of `db.api.md` and `auth.api.md` by changing
   drizzle-orm's peer resolution (270fc6b), so a report can churn on a dependency-graph change with no API
   change at all, and `pnpm -w api-extractor` is red until someone regenerates it.
8. ⬜ **`hf_invitation` is a table with no code path** (track C). `invitationLimit: 0` because an invitation
   ends in a sign-up and `disableSignUp: true` means there is none. When invitations become a feature, the
   plan has to say what an invited user signs up *into* — the table is the only part already there.
