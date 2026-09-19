# Hyperfixation Phase 2 — implementation order

**Date:** 2026-09-18. Derived from [hyperfixation-plan-2026-09-15.md](hyperfixation-plan-2026-09-15.md) —
"Phase 2 — the demo loop end to end (locally)", *The machinery tables*, *The ledger protocol*, *The approvals
protocol*, *Resolution* — and, for the pieces the plan marks "unchanged from v1", the v1 plan at
`~/Code/planning/workbench-plan-ts-2026-09-15.md` (not in this repo; its Phase 2 section, tables and
resolution section are the source for the columns and tests below). **The design is fixed; this document only
orders it.** Where it disagrees with the plan about *what*, the plan wins; about *when*, this one does.

**Written against `4d08ac2`**, which is `origin/main` (fetched 2026-09-18; the checkout is not stale), and
`hyperfixation-template` at `0c15f1f`. Every "exists / does not exist" claim below was checked by reading
source, not by trusting the plan's *Implementation status* table — that table still says auth, admin, cli, the
ESLint config and the template are "Not started", which has been false since 2026-09-18.
[hyperfixation-phase1-order-2026-09-16.md](hyperfixation-phase1-order-2026-09-16.md) is the record of what
Phase 1 actually built; this document assumes it and does not restate it.

**Marker scheme** — the same as Phase 1's:

| Marker | Means |
|---|---|
| ✅ Done | built as specced |
| ✅ Done (deviated — see note) | built, but differs from this document's literal wording |
| 🚧 In progress | partially built |
| ⬜ Not started | nothing built yet |

**Landed so far (core main at `1f3a857`, 2026-09-19):** chunk 0 (#8), L1 (#10), C1 (#11), P1 (#13), L2 (#14), L3 (#17),
C2 (#18), P2 (#19), L4 (#21), P3 (#22), C3 (#23), T1 (#24), C4 (#25), L5a (#26), C5 (#28), the T2 core prerequisite
C0 (#30), L5b (#29); in `hyperfixation-template`, T0 (#12), the `replace-demo` drop-step fix (#13), T2a (#14) and T2b
(#15). Their
"Built, and where it differs" notes below record every place the build departed from this document's wording;
the markers on the remaining chunks are unchanged.

## Where Phase 2 starts from — verified against the tree

Phase 2 "adds the rest of each protocol rather than introducing it". What "the rest" is, exactly, at `4d08ac2`:

| Piece | Exists | Phase 2 adds |
|---|---|---|
| `llm.run` (`packages/ai/src/llm-run.ts`) | Gate and completion in full; seven redeploy cases assert on them | The call takes `model: LanguageModelV4`, `prompt: string`, a **TEMPORARY** `estimatedCostUsd` and an optional `costUsd` per call, and calls `model.doGenerate` directly — no provider registry, no prompt file, no cost table, no `generateText`/`experimental_telemetry`, nothing to fill `prompt_hash` or `trace_id` |
| `actions.perform` (`workflows/src/actions.ts`) | The `started`-row pattern, replay, re-entry of a dead attempt's row, `failed` on throw | Only `stubChannel()` exists; the code's own comment says "no `ActionUncertain` and no task creation, which need `hf_task`" |
| `waitForApproval` | Built, including `assigneeId`, `expiresInMs`, `recordType/recordId`, and an app-supplied `notify` | A default notifier; the assignee rule is stored but never read |
| `decide()` | Built with Phase 1's three deviations; replay, `ApprovalBatchRefused`, `ApprovalRunMoved`, fatal `hf_audit` | `edits` are written **unvalidated** (`edited_draft = COALESCE($5::jsonb, …)`); `assignee_id` is never read; no `hf_activity` row (Still open 3); `batch_id` is never written; no Telegram `via` path |
| `reconcile()` | Steps (1), (3), (4), (5), (6) | Step (4)'s action half sets `uncertain` **without the task** the plan requires |
| `@hyperfixation/db` schema | `hf_app_state`, `hf_audit`, `hf_run`, `hf_budget_period`, `hf_llm_call`, `hf_action_log`, `hf_approval`, the auth tables | **Eight tables absent**: `hf_source_run`, `hf_source_record`, `hf_record_link`, `hf_score`, `hf_activity`, `hf_task`, `hf_label`, `hf_outcome`. No `hfRecordColumns()` mixin. `delete-guard.ts` already names `hf_record_link`/`hf_label`/`hf_outcome` and regenerates over whichever exist — so they join the guard the moment they exist, untested until then (chunk 3's lesson) |
| `records.archive()` | Built; writes `UPDATE <table> SET archived_at = now()` | **Latent defect:** the template's `demo_note` has no `archived_at` column, so archiving a demo record in a generated app fails with `42703`. Closed by the mixin (chunk 0 / T0) |
| `@hyperfixation/core` registries | Seven: `flows`, `sources`, `resolvers`, `scorers`, `approvalTypes`, `channels`, `records.types` — the first six are **name-only** definitions (`{ name, recordType? }`) | Behaviour behind sources/resolvers/scorers; `pages` and `schedules`; the outcome spec; resolution; activity/tasks/labels/outcomes; the workspace (the template's `/w` page is a placeholder with `TODO(phase 2)`) |
| `@hyperfixation/admin` | `users` resource, reset action, router, guard | Resources for `hf_approval`, `hf_run` (read-only) and `hf_budget_period` (`budget_usd` editable) |
| `@hyperfixation/testing` | `MockLanguageModel`, `spawnWorker`/`killAt`, fencing failures | **No `runFlowSync`** — the template's `flow-restart.test.ts` hand-rolls the restart with `bumpAttempt` + `enqueueInTransaction`. **No `withClock`** (deliberately, per Phase 1) |
| `hyperfixation-template` | One flow (`recordDemoNote`, one upsert step on `resolve`), `flow-restart.test.ts`, `compose-envs.test.ts`, the exit-bar e2e; `prompts/` holds only a README; `instrumentation.ts` carries `TODO(phase 2)` for Langfuse | The demo registrations, `tests/contract.test.ts`, the workspace route rendering something |
| `/api/status` | Reports current + previous period with drift, approvals by status, queues, anomalies | Nothing — Done-means 6 is already met by Phase 1 |

## Four corrections this ordering pass produced

1. **`withClock(pgTimestamp)` cannot be built as the plan words it.** The plan: "pins Postgres's `now()` for
   a test database (a `SET` on the session that the budget gate's period stamp reads)". Two things make that
   literal shape impossible: Postgres has no session setting that changes `now()`; and the gate runs on the
   **worker's** step pool in a **child process** (`spawnWorker`), so a `SET` issued from the test's session
   reaches none of the connections that evaluate the stamp. The gate's stamp
   (`to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')`, `llm-run.ts`) has to read *something* a test can move
   from outside the worker, and every candidate is a production-SQL change. **Open question 1** below; it
   blocks exactly one sub-case, `budget.test.ts` (a), and nothing else — so it is ordered last in its track,
   and the three sub-cases that need no clock are not held behind it.
2. **Phase 2's tree forks three ways after one chunk.** Phase 1 was a serial spine because every chunk
   touched the same pool-and-worker boundary. Phase 2's three protocols live in three packages and share
   nothing but the tables: the ledger completion is `ai`, the approvals/actions completion is `workflows`, and
   registries/resolution/workspace are `core`. **All eight Phase 2 tables and the mixin ship in one migration
   in chunk 0**, before the fork, so no track ever appends to the journal — the one shared surface Phase 1's
   merge-friction section identified. Any later column is its own nullable `ADD COLUMN` migration and bumps
   `migrate.test.ts`'s count literal, the same cost Phase 1 paid four times.
3. **The workspace's package boundary was undecided, and it is the largest chunk** (decided since: descriptors, template renders — open question 2). The plan routes
   `(workspace)/w/[[...path]]` to `@hyperfixation/core/workspace`, which reads as core shipping React. Every
   Phase 1 package that faced this (`auth`, `admin`) chose the other shape — resolve a route, return a
   descriptor, let the template render — precisely because a package "cannot depend on `next`". A workspace
   with an inbox, batch approve, inline edit, a board and a timeline is not a descriptor. **Open question 2**;
   it is ordered last in track C so nothing else waits on it.
4. **Two protocol readings the implementer will need that the plan leaves implicit**, stated here so they are
   argued about on paper rather than discovered in review: when `ActionUncertain` fires, and where the eight
   new tables sit in the lock order. Both under "Readings taken", below.

## Infra: what blocks, what stubs

| Needs real infra | Why it cannot be stubbed |
|---|---|
| `COPY … FROM STDIN` into an `UNLOGGED` table, `DISTINCT ON`, `ON CONFLICT DO UPDATE` | The loader *is* these statements; the classifier already sees `pg-copy-streams` (`fenced-client.test.ts`) |
| `pg_trgm` `%` under `SET LOCAL pg_trgm.similarity_threshold`, `EXPLAIN` at 200k rows | The index-use assertion is the point |
| `SAVEPOINT` per record inside `ctx.tx` | Real transaction semantics |
| `40P01`/`55P03` counts under a 200-iteration stress | The lock order is the thing under test |
| `killAt` inside `waitForApproval`'s step; `dbos workflow delete` | The approvals negatives are crash and DBOS-row cases |
| 100 runs × 100 `reconcile()` passes | Kill switch at scale |
| mailpit | The exit bar reads the send from it |

| Builds with no infra | Note |
|---|---|
| Prompt files by content hash | Read a directory, hash bytes; a unit test with a temp dir |
| Provider registry and cost estimation | A table of models to prices; pure |
| Zod validation of an edited draft; the assignee rule | Pure functions over a row and a schema |
| Mixin snapshot | Drizzle metadata → JSON, compared to a committed snapshot |
| Workspace escaping (`<img>` in a draft renders as text) | Render to a string and assert |
| Langfuse registration | Tests run with the keys **unset** and assert nothing registers; with a fake exporter, assert attributes |

**Never in tests:** a real provider call (no key in CI; `MockLanguageModel` implements `LanguageModelV4`, so the
registry hands it out like any provider), a real Langfuse endpoint, a real Telegram bot.

---

## The spine

Only one chunk is truly serial. Each chunk is one PR; the done-check is the named test that first passes
because of it.

### 0 — The eight tables, the mixin, one migration — ✅ Done (db half; T0 template half landed as template #12)

`@hyperfixation/db`: Drizzle definitions and `0004_machinery.sql` (one migration, every table) for
`hf_source_run`, `hf_source_record`, `hf_record_link`, `hf_score`, `hf_activity` (**with `run_id text null`**,
the timeline column the plan adds over v1), `hf_task`, `hf_label`, `hf_outcome`, with v1's columns and the
`(record_type, record_id)` composite index on each polymorphic one. `hfRecordColumns()` — `created_at`,
`updated_at`, `archived_at`, `stage`, `score`, `score_explanation`, `spec_version`, `normalized_name`; every
column nullable or defaulted, none unique — plus the snapshot test that pins it. The journal baseline grows.
(The plan here also had `migrate.test.ts`'s three count literals go `"4"` → `"5"`; #5 replaced them with a set
derived from the journal, so a new migration no longer touches that file.)

Two things that are only *testable* now: the delete guard over the three referencing tables it already names
(a real `hf_label` row must make `DELETE` on its record raise `restrict_violation`), and E002 over the new
tables (it scans `pg_attribute` for every table with a `record_type` column, so they join automatically —
assert that they do).

> **Built:** `0004_machinery.sql`, `schema/machinery.ts`, `schema/records.ts`. `hf_task` carries `origin_ref text null` with a
> partial unique index `(origin, origin_ref) WHERE origin_ref IS NOT NULL` (open question 6's default). `hf_source_record`
> has a unique `(source, external_id)`; `hf_record_link.source_record_id` is unique; `record_id` is `text` throughout.
> `core`'s `records.test.ts` fixture now carries the mixin's full column set.

Template half (**T0**, same PR or the next): `demo_note` adopts the mixin — which is what closes the
`records.archive()` `42703` — and the `record.ts.hbs` generator emits it. The `_trgm` index stays the app's.

**Done:** `pnpm --filter @hyperfixation/db test` green including `migration-policy`, the journal snapshot,
the mixin snapshot, delete-guard over real referencing tables, and E002 over a `record_type` value planted in
`hf_label`; `pnpm --filter @hyperfixation/core test records` green against a mixin-shaped table.

> **After chunk 0 the tree forks.** Tracks L, P and C touch disjoint packages; track T's first chunk needs
> only chunk 0. See Parallelism.

---

## Track L — the ledger completion (`@hyperfixation/ai`)

### L1 — Provider registry, prompt files, the AI SDK call — ✅ Done (deviated — see note)

`createProviders({ anthropic?, openai?, … })` keyed by model name, with a cost table that turns
`(model, input, output)` into `estimated_cost_usd` before the call and `cost_usd` after it. Prompt files: read
from the app's `prompts/` directory, addressed by name, `prompt_hash` = sha256 of the bytes read, both
written on the row. `llm.run` moves from `model.doGenerate` to the SDK's `generateText`/`generateObject`
with `experimental_telemetry` carrying `runId`, `key`, `promptName`, `promptHash` — the join Langfuse needs —
and `LlmRunOptions` loses the two TEMPORARY fields and the per-call `model` object. `@hyperfixation/ai` gains
`ai` as a dependency (only `@ai-sdk/provider` today; `testing` already carries `ai@^7`).

> **Built, and where it differs from the wording above:** `createLlm({ providers, promptsDir })` returns the `llm` flows call —
> `LlmRunOptions` is `{ key, model: string, prompt: string, input, schema? }` with `model` a registry name and `prompt` a file
> under `promptsDir`. `ai@7.0.102`'s telemetry has no `metadata` field or tracer, so the four join fields (`runId`, `key`,
> `promptName`, `promptHash`) travel as `runtimeContext` + `telemetry.includeRuntimeContext`; **L2 must consume that**, not
> `ai.telemetry.metadata.*` span attributes. `generateText` runs with `maxRetries: 0` (its default of 2 would re-bill a
> call the ledger never sees). `@ai-sdk/anthropic` and `@ai-sdk/openai` are pinned **exactly** (4.0.54, 4.0.67): the
> current majors pin `@ai-sdk/provider@4.0.17` against `ai@7.0.102`'s 4.0.15 and are type-incompatible; move them
> together with `ai` and `@ai-sdk/provider` (in `ai` and `testing`) when upgrading. `DEFAULT_COSTS` prices are list
> prices, not yet checked against a bill line. The fixture provider (open question 5) is not in this chunk.

**The seven redeploy cases in `ai` are this chunk's regression net.** They assert on every ledger column the
gate and completion write, and they all construct `LlmRunOptions` — they will not compile until re-pointed at
the registry, which is the intended friction: a case that stops asserting on `estimated_cost_usd` because the
field moved has lost its teeth.

**Done:** `ledger-branches.test.ts` green re-pointed; a prompt-file test (hash on the row; an edited file
yields a new hash on the next call and a `LedgerKeyCollision` on the *same* key only if `input_hash` moved —
the prompt hash is recorded, not fenced); redeploy cases 1, 2, 3, 4, 8, 9, 12 green **unchanged in what they
assert**.

### L2 — Langfuse wiring — ✅ Done (deviated — see note)

`startWorker()` registers Langfuse's OTel span processor when `LANGFUSE_*` are set and nothing when they are
not (the worker fixture's `skipOpenTelemetrySetup: true` stays); `trace_id` lands on the row. The web half is
the template's `instrumentation.ts` (T3). Sentry's `TODO(phase 2)` beside it is **not** this chunk's — the
DSN is provisioned by Phase 3's `hf new`, and the plan's Phase 2 text does not name Sentry (open question 7).

**Done:** with the keys unset, `startWorker()` registers no processor (assert on the OTel global); with a
fake in-memory exporter, one `llm.run` produces a span whose attributes carry the four telemetry fields and
whose id is the row's `trace_id`.

> **Built, and where it differs from the wording above:** `registerLangfuse(env = process.env)` in
> `workflows/src/langfuse.ts` — all three of `LANGFUSE_PUBLIC_KEY`/`SECRET_KEY`/`BASE_URL` non-empty or it
> registers nothing and returns `undefined`; `startWorker()` calls it before `DBOS.setConfig`, passes
> `tracingEnabled: langfuse !== undefined`, and the SIGTERM handler flushes the batch before `process.exit`
> (still no `await` in the handler — the flush is chained onto `DBOS.shutdown`'s `.then`). `ai` gains
> `@ai-sdk/otel@1.0.102` and pins **`ai` to `7.0.102` exactly**: `@ai-sdk/otel` depends on `ai@7.0.102` and
> `@ai-sdk/provider@4.0.15` exactly, so a caret would duplicate `ai` under it. Its `OpenTelemetry` integration
> is one module-level instance passed per call as `telemetry.integrations`, not `registerTelemetry()` (a test
> builds a `createLlm` per call). The join fields arrive as `ai.settings.context.<key>` attributes, **not**
> `ai.telemetry.metadata.*`, and **two** spans carry them — the operation root (`invoke_agent <model>`) and
> `step 1`, not one: the inference span (`chat <model>`) does not. `trace_id` is read once from
> `trace.getActiveSpan()` before the gate and written on both gate statements, so `error` and
> `possible_double_charge` rows carry it too. `@opentelemetry/context-async-hooks` is a **runtime** dependency
> of `workflows`, not just a dev one: DBOS's lazy `require`s (`api`, `core`, `sdk-trace-base`,
> `context-async-hooks`) are undeclared and resolve only through pnpm hoisting. Verified by probe: under fake
> keys DBOS launches with `globalParams.tracingEnabled = true`, `enableOTLP = false`, keeps our
> `NodeTracerProvider` as the global delegate, and runs workflow and step bodies under real `SpanImpl` spans
> sharing one trace id. No filtering beyond `LangfuseSpanProcessor`'s default, and the web half is still T3.

### L3 — `ledger-crash.test.ts` (re-scoped) — ✅ Done (deviated — see note)

Same-version only: `killAt(key, 'after-checkpoint')` → zero extra calls; `'before-checkpoint'` → one extra,
`possible_double_charge = true`; a 1,000-record loop yields 1,000 rows; a second `llm.run` in one run with the
same `key` and a different `input_hash` throws `LedgerKeyCollision`. Redeploy case 3 already proves the first
of these across a relaunch and `ledger-branches` the last in-process; this file exists because the plan's
Phase 2 verification names it, and it should **reuse** case 3's fixture rather than duplicate it.

**Done:** `pnpm --filter @hyperfixation/ai test ledger-crash`.

> **Built, and where it differs from the wording above:** only the two crash cases use case 3's fixture
> (`llmFlow` + `spawnWorker`/`killAt`, both workers on one explicit `version`, 12 keys rather than 24 — the
> kill point is what the case turns on, not the loop's length); the 1,000-record loop and the collision drive
> `llm.run` in-process through a `createStepPool` `ctx.tx`, the way `ledger-branches` does, because neither
> needs a worker and a spawned one would cost a DBOS checkpoint per record. No test-support file was added.
> Three test databases in the file, one per `describe`: the loop asserts `hf_budget_period.spent_usd` as an
> absolute figure (1,000 × $0.001), which only holds on a database no other case has spent against. The
> same-version `before-checkpoint` crash needs no `reconcile()` bump — worker B is not a new SHA, so DBOS's
> own recovery re-executes the uncheckpointed step, the gate finds the `started` row and flags it, and the run
> finishes at `attempt = 1`. Whole file: 4 tests in ~14 s (the loop ~4 s), stable over three runs; the loop's
> timeout is 60 s, the crash cases' 240 s as in case 3.

### L4 — `kill-switch.test.ts` — ✅ Done (deviated — see note)

100 runs each orphaning one `started` row by failing, then 100 `reconcile()` passes: 100 `abandoned` rows,
derived reservation 0, the period's `spent_usd` unchanged, `BudgetExceeded` still fires at the budget. Then
the case redeploy case 9 deferred here: an `abandoned` row revisited by a later attempt of a **`waiting`** run
(decide it) is flagged, set back to `started` under the current attempt, counted in the reservation, and moved
to `ok` once.

Lives in `ai` — it drives `llm.run` — though the plan's verification line lists `kill-switch` under the
`workflows` filter (open question 8, trivial).

**Done:** `pnpm --filter @hyperfixation/ai test kill-switch`. Budget the runtime: 100 passes each scanning
`hf_run` is seconds, not minutes, but say so in the file's timeout.

> **Built, and where it differs from the wording above:** no worker is spawned — both halves run in-process
> against a `createStepPool` `ctx.tx`, with `getClient()` and the probe pool handed to `reconcile()` and
> `decide()` as the control plane, which works with no `DBOS.launch()` because `migrate()`'s
> `dbos schema -s dbos -r <role>` step already created the system schema. Half (1)'s 100 orphans are inserted
> directly (two `generate_series` statements: a `failed` run and a `started` row on the attempt that was
> current), since redeploy case 9 already proves a real kill leaves exactly that row and 100 killed workers
> would cost minutes; the `spent_usd` the passes must not move is made non-zero first by one real `llm.run`,
> so "unchanged" is a claim about a figure that is not zero. Half (2) needs the reservation read *mid-flight*,
> which no cassette can do, so the file carries a 40-line `ParkedCall` `LanguageModelV4` whose `doGenerate`
> parks until the test releases it — attempt 1 parks forever (the answer a dead process never gets), and
> attempt 2 is released to carry the row to `ok`. Two databases, one per `describe`, because half (1) asserts
> absolute `spent_usd`. Two assertions beyond the wording: every pass reports `anomalies: []` and
> `failures: []` (a pass that was quietly failing would otherwise still "abandon 100"), and a call that *does*
> fit still passes after the 100 orphans — round-3 finding 6's lesson is that a spurious refusal is the worse
> failure. Whole file: 2 tests in ~1.4 s, the 100 passes ~0.5 s of that, stable over three runs; both timeouts
> are 60 s, which is two orders of magnitude of headroom on a shared Postgres.

### L5a — `budget.test.ts` (b), (c), (d) — ✅ Done

(b) *re-entry through the gate*: an `abandoned` `$1` row on a `waiting` run, period at `budget − $0.50`,
`decide()` → the replaying attempt's `llm.run` throws `BudgetExceeded`, row stays `abandoned`. (c) *lock-order
stress*: 200 iterations of concurrent gates, completions, `reconcile()` passes and `decide()` calls across 8
runs, zero `40P01`, zero `55P03`. (d) *the finding-8 inversion*: a completion and a gate on the same
`(run_id, key)` driven in lock-step from two connections cannot deadlock. None of these touch the clock.

**Done:** `pnpm --filter @hyperfixation/ai test budget` green for (b)–(d), with (a) `it.todo` naming open
question 1.

> **Built, and where it differs from the wording above:** 4 tests plus (a)'s `it.todo` in ~3.3 s over three
> runs, on **one** test database for the whole file — every case sets the `hf_budget_period` row it needs, so
> three databases bought nothing. **No env gate was needed:** (c)'s 200 iterations run in ~2.7 s, so the
> `HF_STRESS` switch the Risks section allows was not added and CI needs no new variable. Everything is
> in-process (`createStepPool` + `decide()`/`reconcile()` from `@hyperfixation/workflows`, no worker), the
> way `approvals.test.ts` drives `decide()`.
>
> (c) drives 1,200 operations — 4 gates+completions, one `reconcile()` pass and one two-run `decide()` batch
> per iteration — over 8 runs, and the `decide()` batch deliberately targets **two of the same runs being
> gated**, so its `hf_run FOR UPDATE` really queues behind a gate's `FOR SHARE`. That produces ~300
> `StaleAttempt` refusals per run, which the case asserts are the *only* refusals, on top of zero `40P01` and
> zero `55P03`; with the run sets disjoint every operation succeeded and the case proved much less. It also
> asserts the period's `spent_usd` still equals `SUM(cost_usd)` of its `ok` rows at the end — the payoff of
> the order — which is why its `beforeAll` first repairs the invariant (b) breaks by writing `spent_usd` by
> hand.
>
> (d) is **two** cases, one per transaction, and each was verified by inverting production's order and
> watching it fail with `40P01` before the order was put back: moving the completion's budget `UPDATE` after
> its ledger `UPDATE` fails the completion case only, and taking the ledger row before the budget row in the
> gate fails the gate case only. The lock-step lever is a `pg.Client` of the test's own holding the period row
> while the production transaction blocks on it, and the case then takes the *ledger* row from that same
> connection — the second half of finding 8's cycle, granted immediately under this order. For the completion
> half the park sits in `LedgerContext.tx`, counting transactions: the completion is the second one, and
> nothing else reaches between the gate and it. Blockage is detected through `pg_stat_activity`
> (`wait_event_type = 'Lock'`, scoped to `current_database()`), not `pg_locks` — a row-lock waiter waits on
> the holder's `transactionid` lock, whose `pg_locks.database` is null and so cannot be scoped to one
> database on a shared instance.
>
> **Worth knowing for the plan:** (c) passed under *both* inversions. It is a genuine lock-order stress, but
> it is (d), not (c), that pins finding 8 — round 3's note that "`budget.test.ts` runs a 200-iteration stress
> … and asserts zero `40P01`" should not be read as the regression test for the inverted order.

### L5b — `withClock` and `budget.test.ts` (a) — ✅ Done (deviated — see note)

**Decided: an injected clock, not a database-level override.** The three original candidates ((i) GUC +
`ALTER DATABASE` + restart, (ii) a core-owned `hf_now()` function, (iii) a manual once-off run) are dropped
in favour of a fourth, found during the session: `llm.run`'s gate stops reading SQL `now()` for the period
stamp and instead calls a `clock: () => Date` handed to it through the same place `runs.start`/`decide()`/
`reconcile()` already get their handles — `ControlPlane.attach({ pool, client, clock? })` in
`packages/core/src/define-app.ts`. `clock` defaults to `() => new Date()`. Production `startWorker()` never
passes one. Only `@hyperfixation/testing`'s worker module (`worker-module.ts`, already the sole reader of
`WORKER_CONTROL_ENV`) constructs a controllable one and attaches it — a package production code never
depends on, the same trust boundary this plan already draws around `records.archive`/control-plane ops, and
the same *shape* of seam `attach()` and `MockLanguageModel` already are, not a new kind of one.

`WorkerControl` gains `clockOffsetMs?: number`, read at spawn (mirrors `drainMs`) — this is what `withClock`
sets for "frozen from the start" cases. **Live mid-run advance** (case (a) needs the clock to move *while
the cassette has the call parked*) reuses the worker's existing stdin channel — `WORKER_RELEASE` already
updates live worker state with no restart; a new `clock <iso-timestamp>` line is the same shape. No
`ALTER DATABASE`, no new SQL function, no migration-allowlist exception, no worker restart — and, unlike the
GUC route, no config-level toggle that could be left on a real database by accident.

**Rejected and why:** (i) plants a permanent `COALESCE(current_setting('hf.clock', true)::timestamptz,
now())` in the money-gate's own query, with its override living in database config outside the app's trust
boundary — exactly the failure class round-3 finding 7 exists to prevent, now reachable from outside the app
entirely — and pooled connections keep their GUC from connect time, so it doesn't actually satisfy case (a)'s
live-advance requirement without a restart that would also blow away the parked step. (ii) shares that
restart problem and costs a function call on every production gate forever. (iii) never runs in CI, which
defeats the point — this is the one case in the phase guarding round-3 finding 7.

`withClock('2026-09-30 23:59:58Z')`, a run reserves, the clock moves to `2026-10-01 00:00:02Z` before the
provider returns (the cassette parks it, then the new stdin message advances the clock), the row's
`period = '2026-09'`, September's `spent_usd` carries the cost, October's row is `0`, drift 0 in both; a
fresh October gate creates `'2026-10'` from `hf_app_state.budget_usd` and a stale September `started` row
counts nothing against it.

**Done:** (a) turns from `it.todo` to green; `redeploy-case-12` and `ledger-branches` still green (the stamp
expression changed under them).

> **Built, and where it differs from the wording above:** the seam is **`CreateLlmOptions.clock?: () => Date`,
> owned by `createLlm` in `packages/ai/src/llm-run.ts`** — not `ControlPlane.attach`. `attach()` lives in
> `@hyperfixation/core`, which `@hyperfixation/ai` does not and cannot depend on (the dependency runs the
> other way), so the gate had no way to read a clock passed there. The *intent* of the decision is unchanged:
> one optional injected clock, unset on every production path and in practice constructed only by
> `@hyperfixation/testing`, no SQL `now()` override, no new function and no migration. Unset, the gate reads
> the period from Postgres exactly as before — see the trade-off below. The alternatives considered and rejected for the same reason the doc rejects the GUC:
> `LedgerContext`/`StepContext` would have routed a test knob through `workflows`' `step()` and
> `startWorker()`, which is production surface.
>
> **Pinned, not offset.** `WorkerControl.clockAt?: string` (an ISO instant) replaces the planned
> `clockOffsetMs`: an offset ticks relative to real time and a spawned worker takes seconds to reach ready,
> so the instant a case arranges would drift by however long the launch took. The live advance is as planned
> — a `clock <iso>` line on the worker's stdin, alongside `release`, exposed as `SpawnedWorker.setClock()`.
> The stdin handler in `worker-module.ts` is now **line-based** rather than `chunk.includes(keyword)`,
> because `clock <iso>` is the first message that carries an argument.
>
> **The dates are a century out, not September/October 2026.** Under the real current period the doc's
> `2026-09`/`2026-10` would be indistinguishable from what SQL `now()` used to return, and the case would
> pass whether or not the injected clock was ever consulted. It uses `2099-12-31T23:59:58Z` →
> `2100-01-01T00:00:02Z`, which also makes the year rollover implicit. Verified by falsification: dropping
> the `clock` argument from the case's first `createLlm` fails it on `period`.
>
> **Case (a) is in-process**, no worker: the period semantics live entirely in `openGate`/`complete`, and
> L4 already proved a mid-flight park needs only a parked cassette. `ParkedCall` moved from
> `kill-switch.test.ts` to `packages/ai/src/test-support/parked-call.ts` for that reuse, with kill-switch's
> assertions untouched. The worker-side plumbing (`clockAt` + the `clock <iso>` line) is under test once, in
> `packages/testing/src/spawn-worker.test.ts`.
>
> **Postgres is still the production time authority.** The gate's `SELECT` is byte-for-byte `origin/main`'s,
> `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')` included, and the period comes from it whenever no clock is
> injected; `periodOf(clock())` is taken *only* on the injected branch. A first cut defaulted the option to
> `() => new Date()` and dropped the SQL, which was wrong: with N workers and host-clock skew S, for S
> seconds around a month boundary two workers would stamp different periods, lock different
> `hf_budget_period` rows and be unable to see each other's reservations. One database clock is precisely
> what the SQL expression was buying, so "production never passes a clock" has to mean the production SQL is
> unchanged too. There is **no** new single-read property to claim — `origin/main` already read the stamp
> once per gate transaction into JS and bound it to every later statement, and that is untouched. The
> completion still bills `gate.period`, `finished_at = now()` stays real time (audit time, not a billing
> period), and `status.ts` and `reconcile()` are untouched — the invariant "billed to the period on its own
> row" makes drift exact regardless of which month the reader is in.
>
> **Worth knowing:** the re-entry `UPDATE` re-stamps `period` to the *replaying* gate's month, by design. A
> September `started` row re-entered in October bills October, and the row carries `possible_double_charge`
> to say so. The only other `to_char(now() …)` readers left are two tests' own —
> `packages/ai/src/test-support/ledger-harness.ts`'s `currentPeriod()` and a seed in
> `ledger-branches.test.ts` — both real time, which agrees with the gate's default clock.

---

## Track P — approvals and actions completion (`@hyperfixation/workflows`)

### P1 — `ActionUncertain`, the task, `reconcile()` step (4)'s task — ✅ Done (deviated — see note)

`ActionChannel` gains the declaration of whether it dedupes on `idempotencyKey`. `actions.perform`: on
re-entry of a `started` row (the branch `actions.test.ts` calls "takes a started row left by a dead attempt
back under this one") with a channel that does not dedupe, throw `ActionUncertain`, set the row `uncertain`,
insert one `hf_task` (`origin = 'flow'`) and one `hf_activity` row, all inside the same `ctx.tx` — never
re-send. `reconcile()` step (4)'s action half gains its task (`origin = 'sweep'`), **exactly once per row
across passes**, which needs an idempotency key on `hf_task` that v1's columns do not give it (open
question 6). The lock-order tier for `hf_task`/`hf_activity` is under "Readings taken".

> **Built, and where it differs from the wording above:** `ActionChannel.dedupes` is a **required** boolean (`stubChannel` is
> `true`). A non-deduping channel treats a `failed` row like a `started` one on re-entry — a channel that throws after
> delivering (SMTP accepted, socket timed out) must not be re-sent either. A row already `uncertain` makes **any** channel
> throw `ActionUncertain` on re-entry, deduping ones included: a human has been asked, and a send behind them is what the
> task exists to prevent. `ActionUncertain.taskId` is `number | null` (a row that went `uncertain` before this chunk has
> none). The activity row is written even when the task insert conflicts — exactly-once comes from the
> `started -> uncertain` transition, not the task insert. A task's `record_type`/`record_id` are **NULL** when
> the action carries no record — corrected after P2's CI: the `('hf_action_log', id)` stand-in this note first
> described is a record type no app registers, so E002 failed the next worker boot (`redeploy-case-1`). E002
> ignores NULL, and `origin_ref` is the back-pointer to the action row. `0005_nullable_activity_task_record`
> drops the `NOT NULL` on `hf_activity` and `hf_task`'s target columns for it.

**Done:** `actions.test.ts` extended — a non-deduping channel re-entered yields `uncertain` + one task + no
second `send`; a deduping channel re-entered re-sends with the same `idempotencyKey` (today's behaviour,
now conditional); `reconcile.test.ts` step (4) — one task per orphaned action row, unchanged across three
passes. Redeploy cases 1 and 8 still green (`stubChannel` is re-declared as deduping).

### P2 — `decide()` completion: Zod, the assignee rule, `hf_activity`, `batch_id` — ✅ Done (deviated — see note)

Validate the whole batch before writing, as step 2 of the protocol lists it: every edited draft parses against
the approval type's Zod schema; `assignee_id IS NULL OR assignee_id = userId` or the user is an admin —
refusals join `ApprovalBatchRefused`'s per-row reasons. `hf_activity` insert per decided approval, **fatal**
under the same rule as `hf_audit` (Phase 1 Still open 3, closed here). `batch_id` written on every row of a
multi-row batch. `zod` becomes a direct dependency of `workflows` (`auth` already has one, for the same
TS2742 reason).

One constraint the plan does not state: **the schemas live in `core`'s `approvalTypes` registry and
`workflows` cannot import `core`** (cycle — `core` depends on `workflows`). So `decide()` has to be *handed*
the schema lookup, the way it is handed the pool and the client; `app.approvals.decide(options)` in
`defineApp` is where the registry closes over it. The shape is the implementer's; the constraint is not.

> **Built, and where it differs from the wording above:** the lookup is `DecideOptions.schemaFor(type)`, sync and
> pure, called inside the locked transaction; `ApprovalDraftSchema` (a re-exported `ZodType`) is what `core`'s
> `ApprovalTypeDefinition.schema` is typed as, so `core` still needs no `zod` of its own. `edits` with no
> `schemaFor` is a **`TypeError` thrown before the transaction opens** — a wiring bug, not a refused row — which
> made `wait-for-approval.test.ts`'s one `decide()` call gain a `schemaFor`; it asserts exactly what it asserted.
> The value written to `edited_draft` is **what the schema returned**, not what the caller sent, so a `z.object`
> strips what it does not declare. Admin is `DecideOptions.admin`, a boolean the caller's session sets: `via:
> 'admin'` alone does not clear the assignee rule, the flag does. `via` in {`archive`, `sweep`} is **exempt** from
> the rule outright — neither carries a human decider, and an assigned row has to stay cancellable and
> expirable. `hf_activity.run_id` is `NULL` (reading 4), `actor_id` is the decider, `kind` is
> `approval.<decision>`, and `record_type`/`record_id` are **NULL** when the approval is about no record — a
> `('hf_approval', id)` stand-in is a record type no app registers and fails E002 at the next worker boot, and
> the audit row's `target_id` already carries the id; the insert is
> last in the transaction, after every `hf_approval` write, per reading 2. `batch_id` is a `randomUUID()` stamped
> on every row when the deduped `ids` number more than one, `null` otherwise, and `DecideResult.batchId` carries
> it (a replay reads the stored one back). `defineApprovalType()` was **not** added — that is C-track's.

**Done:** `approvals.test.ts` — a batch with one edit that parses is written with `edited_draft`; an edit
that fails the schema refuses the whole batch naming the row; assignee mismatch refused; an admin decides an
assigned row; one `hf_activity` row per decided approval; a `hf_activity` insert made to fail (a `BEFORE
INSERT` trigger installed by the test) leaves the approval `pending`, creates no `dbos.workflow_status` row,
and a retry with the same `decisionKey` succeeds. Adversary target (c) is a test of its own: a `schemaFor`
that throws rolls the whole transaction back and the throw leaves `decide()` unaltered. `records.test.ts` in
`core` covers the registry end — a registered schema refusing an edit through `app.approvals.decide`, and
`records.archive()` still cancelling an approval assigned to someone else. `checkE002(pool, [])` is asserted
green after a decision and after an uncertain action on rows that carry no record, in `approvals.test.ts`,
`actions.test.ts` and `reconcile.test.ts` — the regression `redeploy-case-1` caught.

### P3 — The approvals negative suite — ✅ Done (deviated — see note)

The plan's list, mapped against what `approvals.test.ts` and `wait-for-approval.test.ts` already prove:

| Case | At `4d08ac2` | Lands at |
|---|---|---|
| batch with one edit | edit stored, unvalidated | ✅ P2 (#19): parsed against the type's Zod schema, the parsed value stored |
| stale row refuses the whole batch with per-row reasons | ✅ | — (`approvals.test.ts` "refuses the whole batch, writing nothing, when one row is not pending") |
| assignee mismatch refused | ⬜ | ✅ P2 (#19) |
| replayed `decisionKey` returns the first result, writes nothing | ✅ | — (`approvals.test.ts` "returns the earlier result and writes nothing when the decisionKey replays") |
| crash inside `waitForApproval` creates no second row | ⬜ (`killAt('approval', 'in-tx')` on the step, then a second attempt) | ✅ P3: `wait-for-approval.test.ts` "creates no second row when the gate is re-entered, and resumes under the live version" |
| two pending approvals on one run; deciding the second resumes with the second's decision, leaves the first pending (3b) | ⬜ | ✅ P3: `wait-for-approval.test.ts` "resumes with the decided row's own decision and leaves the run's other approval pending"; `approvals.test.ts` "decides the second of a run's two pending approvals and leaves the first pending" |
| `dbos workflow delete` on the run's rows before deciding loses nothing (3c) | ⬜ | ✅ P3: `wait-for-approval.test.ts` "loses nothing when the run's DBOS workflow rows are deleted before the decision" |
| resume workflow runs under the current version and is enqueued exactly once when `decide()` is called twice concurrently | ⬜ | ✅ P3: the version half in `wait-for-approval.test.ts` "creates no second row …"; the concurrency half in `approvals.test.ts` "enqueues the resume workflow exactly once when the same decisionKey arrives twice" and "refuses the second of two concurrent decisions carrying different decisionKeys" |
| `hf_audit` insert made to fail → throw, `pending`, no DBOS row, retry succeeds | ⬜ (P2 wrote the `BEFORE INSERT` trigger technique for `hf_activity` in `approvals.test.ts`; reuse it) | ✅ P3: `approvals.test.ts` "hf_audit > is fatal: a failed insert leaves the approval pending and a retry succeeds" |
| `decide()` on X while a step holds `ctx.tx` inside `waitForApproval`'s `INSERT … ON CONFLICT` on X: no `40P01` | ⬜ | ✅ P3: `approvals.test.ts` "the run-first lock order > waits out the held ctx.tx instead of deadlocking on the approval it is deciding" |

The last one has no `killAt` park point: `'in-tx'` parks after the fence statement, before the `INSERT`.
Either add a park point after the insert, or write it in `fence.test.ts`'s style — two raw connections issuing
the real statements in the real order, no DBOS — which is what that case is actually about. Prefer the
latter; it lives in `workflows` (it needs `decide()`), not in `db`.

> **Built, and where it differs from the wording above:** P3 is test-only — no production file changed.
> `killAt('approval', 'in-tx')` is **not reachable**: `parkFor()` is honoured only where a fixture calls it, and
> both of `waitForApproval`'s steps are production code that parks nowhere, so a test-only chunk cannot hold the
> gate inside `createOrRead`. The crash is arranged from the one point inside the gate a fixture owns — the
> `notify` callback, which runs in the `approval:notify` step — reached with the approval row **committed** and
> `notified_at` still NULL. That is the stronger half of the negative anyway: it is the state in which a
> re-entry without `ON CONFLICT DO NOTHING` would open the second row. Worker A (parked there, then `SIGKILL`ed)
> and worker B (a fresh `HF_BUILD_SHA`, whose boot `reconcile()` bumps to `:2`) also give the "current version"
> row for free: `dbos.workflow_status.application_version` is A's on `:1` and B's on `:2` and `:3`.
> The `40P01` case took the `fence.test.ts` route as the document prefers, on a `createStepPool` connection
> inside `approvals.test.ts` rather than a file of its own. Two rows were already green and are cited above
> rather than duplicated. `test-support/approval-flow.ts` grew an optional `extraKey` input (a second pending
> row on the run, opened by a step before the gate, for 3b), the `NOTIFY_PARK_KEY` park point, and a decision
> marker that now carries `runId` and `key` so one worker's log can serve several runs.

**Done:** `pnpm --filter @hyperfixation/workflows test approvals` — every row of the table green.

### P4 — Telegram `via`, the default notifier, expiry — ✅ Done (deviated — see note; notifier moved to C6.3)

**Decided (Graham, 2026-09-19):** the callback handler only, **no bot** — the real bot stays in Phase 6 — and the
default email notifier ships **with C6**, when the workspace URL it needs exists; until then `notify` stays
app-supplied.

Expiry is already built (`reconcile()` step (5), `expiresInMs`), so "expiry" here is only what the notifier
says. The plan's Telegram sentence — "callbacks carry the approval id and a per-message nonce as
`decisionKey`" — is a `decide()` caller with `via: 'telegram'` and `decisionKey = <approvalId>:<nonce>`, and
the bot that would send the message is Phase 6's (`hf_telegram_link` is a Phase 6 table; no `TELEGRAM_*` var
is in `REQUIRED_ENV`). The thin slice this document orders: the callback handler and its replay test, with
no bot. A default email notifier ("link straight to the item") needs the workspace's URL for an approval,
which is C6's — so the notifier ships with C6, and until then `notify` stays app-supplied as it is today.

**Done:** a callback handler test — the same `(approvalId, nonce)` delivered twice decides once; a nonce for
an approval that is no longer pending returns `ApprovalBatchRefused`, not a 500.

> **Built (#34), and where it differs from the wording above:** `packages/workflows/src/telegram.ts`,
> `handleTelegramCallback(update, options)`, takes a **parsed** `callback_query` update (no `Request`/`Headers`) and
> is handed `app.approvals.decide` as `options.decide`, because `workflows` cannot import `core`. Callback data is
> `hf1:<a|r>:<approvalId>:<nonce>`, at most 64 bytes (`encodeCallbackData` throws `CallbackDataTooLong`;
> `maxNonceLength(id)`); `decisionKey = <approvalId>:<nonce>`. A stale nonce needs no store: `decide()` already refuses
> an approval decided under another key (`ApprovalBatchRefused`, "is already approved"). Only deterministic failures
> are absorbed (`refused`; bad/foreign/oversized data → `ignored`); transient ones (`CommitLost`, deadlock) and wiring
> bugs still throw, so the webhook returns 5xx and Telegram's retry is the right one. Two opt-in additions:
> `options.secret` (the `X-Telegram-Bot-Api-Secret-Token` pair, `timingSafeEqual` before the payload is parsed) and
> `options.userFor(from)` → `decided_by` (Phase 6's `hf_telegram_link` answers it; unset leaves the decision
> unattributed). The default notifier is C6.3, as decided.

---

## Track C — registries, loader, resolution, the workspace (`@hyperfixation/core`, `db`, `admin`)

### C1 — Registries with behaviour, `pages`, `schedules`, the outcome spec — ✅ Done (deviated — see note)

`defineSource`, `defineResolver`, `defineScorer` (today's `{ name, recordType? }` definitions grow the
function they name); `pages` and `schedules` registries (a schedule starts a run — "scheduled flows check
`paused` first and return without starting a run" — never a durable sleep); `defineSpec` — a typed, versioned
criteria definition, `spec_version` on `hf_score` and on the mixin. "`actions`" in the plan's registry list
is read as the existing `channels` registry (open question 4). Every registry keeps `createRegistry`'s
duplicate/unknown errors. `core.api.md` will grow a great deal here; regenerate it in the same PR.

> **Built, and where it differs from the wording above:** schedules are **interval** (`every` ms), not cron, and C1 ships
> `schedules.fire(name)` (pause-checked, then `runs.start`) and `schedules.due(now, lastFired)` but **no timer loop** — the
> caller owns the `lastFired` map, and the loop is T2's wiring in the template's `worker.ts`, mirroring `startReconciler`
> (`runs.start` is control-plane, so it cannot be a DBOS scheduled workflow). `App.schedules` is typed over an erased
> `AnySchedule` (as `AnyFlow` is for flows) because `ScheduleDefinition<I>` is contravariant in `I`. `defineSpec` is one live
> version per `name`; `pages` are keyed by `path` with no render field (C6 adds the descriptor). `writeScore(queryable, …)`
> INSERTs into `hf_score` and never updates; C4's `scores.write` wraps it in `ctx.tx` and owns the record's mixin columns.
> New `InvalidDefinition` error beside `DuplicateRegistration`/`UnknownRegistration`.

**Done:** `registry.test.ts` extended for the new kinds; a spec test — scoring against version 2 leaves
version 1's `hf_score` rows and writes new ones; a schedule under a paused app starts no run.

### C2 — The COPY loader and `hf_source_run` — ✅ Done (deviated — see note)

In `@hyperfixation/db` (the layout puts "COPY loader" there): `pg-copy-streams` into a per-run `UNLOGGED`
staging table, `INSERT … SELECT DISTINCT ON (source, external_id) … ON CONFLICT DO UPDATE` into
`hf_source_record` with `payload_hash`, all inside one `ctx.tx` (the classifier counts `COPY` as a write and
the tagged client allows it — `fenced-client.test.ts` already proves the classification). `hf_source_run`
bookkeeping: `rows_in`, `rows_new`, `rows_changed`.

> **Built, and where it differs from the wording above:** the staging table is `CREATE TEMP TABLE … ON COMMIT
> DROP`, not `UNLOGGED` — the application role holds `USAGE` but not `CREATE` on `public` (`roles.ts`), so
> `CREATE UNLOGGED TABLE` is refused with 42501; `TEMP` is granted to `PUBLIC`, has the same no-WAL property,
> and `ON COMMIT DROP` makes the cleanup structural. `loadSource(tx, source, rows)` lives in
> `packages/db/src/loader.ts` and takes rows structurally (`SourceRowInput`), because `db` cannot import
> `core`; `core`'s `SourceRow<P>` is assignable. Within a batch the **last** occurrence of an external id
> wins. `payload_hash` is computed in SQL over `payload::text` (jsonb's canonical form, so key order does not
> change it), never in TypeScript. A changed payload rewrites `payload`/`payload_hash`/`run_id` and resets the
> record to `status = 'new'`, `attempts = 0`, `error = NULL` for C3 to re-resolve; an unchanged one moves only
> `last_seen`, keeping `first_seen`, `status`, `run_id` and `attempts`. `hf_record_link` is never touched. The
> loader writes only `running` → `ok`: a throw anywhere propagates and `ctx.tx` rolls the whole load back, so
> `hf_source_run.status = 'error'` stays unused until C3/T2 own retries.

**Done:** `pnpm --filter @hyperfixation/db test loader` — a batch with a duplicate external id loads once;
the staging table is gone after commit; an unchanged payload leaves `last_seen` moved and `payload_hash`
equal; a `COPY` from outside `ctx.tx` is refused with `UnfencedWrite`.

### C3 — Resolution — ✅ Done (deviated — see note)

A flow on queue `resolve` (concurrency 1). In-batch exact-key grouping first, so duplicates within a batch
produce one record; exact-key join (plus phone and email candidates); then fuzzy, record by record so later
records see earlier creates, the candidate query under `SET LOCAL pg_trgm.similarity_threshold = <t>` using
`normalized_name % $1` (both statements inside `ctx.tx`); re-ranked in process; uncertain → `status =
'review'`; each record in a `SAVEPOINT`, a throw marks it `error` with `attempts + 1` and the batch completes;
a `manual`/`human_confirmed` link is never re-decided; a changed payload updates the linked record in place.

> **Built, and where it differs from the wording above:** what ships is `resolveBatch(tx, { resolver, table,
> source, limit = 500, maxAttempts = 3 })` in `packages/core/src/resolution.ts` — **step-side**, taking the
> caller's open `ctx.tx`, and **chunked by `limit`**: one call is one batch and one transaction, and the caller
> loops until `ResolveBatchResult.done`. One transaction for a whole load would hold `hf_run FOR SHARE` for
> however long 200k rows take to resolve, which is what the fence exists to make impossible. The flow on queue
> `resolve` is **not** here: `defineFlow` registers globally, so a second `defineApp` in a test throws
> `DuplicateFlow`, and the flow over the existing `resolve` queue is T2's wiring in the template's `worker.ts`,
> beside the schedule loop. `app.resolution.batch(tx, { resolver, source, … })` is the registry-resolving
> wrapper: it looks the resolver up and takes `table` from `records.types.require(def.recordType)`.
>
> The exact pass joins **app-table columns named like the payload keys** — `exactKeys` are payload field names
> and the columns they join against carry the same names, with `$n` passed as text so Postgres coerces; there
> are no separate "phone and email candidates", those are just exact keys. A row with a null or missing value in
> any exact key groups with nothing and joins on nothing. The link method for a record the resolver **created**
> is a new `'created'` (confidence `NULL`), so "which link did resolution invent" is a query and not a guess;
> `hf_record_link.method` is plain `text`, so widening `recordLinkMethods` is a TypeScript-only change and
> `drizzle-kit generate` still finds no pending diff. `ResolverFuzzy` gains `payloadKey?: string` (defaults to
> `field`) — the payload side of the compare, already normalized, because the payload key and the record column
> are rarely spelled the same. The re-rank is a built-in dependency-free **bigram Dice** score (`bigramDice`,
> exported): Postgres's `similarity()` orders the candidates, Dice picks among them on one scale that a
> `review()` threshold can be written against without moving under a Postgres upgrade. There is no `score` hook.
>
> A row that already carries a link is updated and **never** re-linked, whatever the method — `manual` and
> `human_confirmed` are not special-cased, because only linkless rows ever enter matching. An in-batch duplicate
> takes its group leader's outcome (`method = 'exact'`, confidence 1) and does **not** get its own `update()`:
> the leader's payload represents the group. `review` rows are **re-scanned every batch** (the scan is
> `status <> 'linked' AND attempts < maxAttempts`), so a parked row comes back when the resolver's thresholds
> change; nothing retries an `error` row past `maxAttempts`. `SET LOCAL pg_trgm.similarity_threshold` is issued
> once before the loop — transaction-scoped, so it survives every `ROLLBACK TO SAVEPOINT` — as an interpolated
> `toFixed(10)` literal, since `SET` takes no bind parameters. `SAVEPOINT` / `ROLLBACK TO` / `RELEASE` need no
> change to the fence: `classify()` already calls all three writes, so they pass inside `ctx.tx` and are refused
> outside it, which is exactly right.

**Done:** `pnpm --filter @hyperfixation/core test resolution` — v1's four cases (in-batch duplicates → one
record; changed payload on a manual link updates the record and leaves the link; a throwing `create()` marks
that record `error` and the batch completes; `EXPLAIN` of the candidate query at 200k rows shows the GIN
index and no seq scan). Give the 200k case its own `describe` and timeout, and measure it once — it is the
first test in the suite whose cost is the data, not the DBOS launch. **Measured:** 12 tests, 2.2s for the
file; the 200k fixture (`generate_series` + the GIN index + `ANALYZE`) is ~0.9s of it, so it carries a 60s
`describe` timeout and no `skipIf` gate. The plan is Limit → Sort → Bitmap Heap Scan → **Bitmap Index Scan on
`big_businesses_normalized_name_idx`**, no `Seq Scan`; the 200k rows live in a table of that describe's own so
the other cases' `beforeEach` truncation cannot take them out from under it.

### C4 — Activity, tasks, labels, outcomes, scores — ✅ Done (deviated — see note)

The step-side helpers (`activity.record`, `tasks.create`, `scores.write` — every one a write through `ctx.tx`,
synchronously inside it, per the run-model rule) and the web-side ones (`labels.add`, `outcomes.record`,
`tasks.complete` — web writes on the web's pool, no fence, but `assertNotInWorkflow()` so a flow cannot reach
them). `hf_activity.run_id` set from the run context on the step side and null on the web side; that column
is what C6's timeline groups by. `records.archive()` gains "cancels open tasks", which v1 lists and Phase 1
did not build (no table).

> **Built, and where it differs from the wording above:** two entry points per protocol rather than one that
> sniffs the handle — `activity.record(ctx, …)`, `tasks.create(ctx, …)` and `scores.write(ctx, …)` write inside
> `ctx.tx`; `tasks.createManual`/`complete`/`cancel`, `labels.add`, `outcomes.record` and every `list` go
> through `controlPlaneTx`, so `assertNotInWorkflow()` refuses them from inside a run.
>
> **`0006_activity_score_key`** is the chunk's one migration, which this ordering did not anticipate: every
> step-side write re-executes on attempt 2 under a new workflow id, and `hf_activity`/`hf_score` had no
> `(run_id, key)` to `ON CONFLICT` on (P1's activity row is exactly-once only because it sits behind the
> `started -> uncertain` transition). It adds `hf_activity.key`, `hf_score.run_id`/`key` and a partial unique
> index `(run_id, key) WHERE key IS NOT NULL` on each — additive, so `migrate.test.ts` has no literal to bump
> (#5's journal-derived set) and only the journal baseline grows.
>
> A flow task's `origin_ref` is `` `${runId}:${key}` ``; the colon keeps it disjoint from `actions.perform`'s
> bare `hf_action_log` id on the same partial unique index. Kinds are `task.created|completed|cancelled`,
> `label.added`, `outcome.recorded`, `score.written`, `record.archived`, and an app-supplied kind is validated
> against `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$` — the shape `action.uncertain` and `approval.<decision>`
> already write. A step's default activity key is `` `${ctx.key}:${kind}` ``: one row per step per kind.
>
> `complete`/`cancel` on a task that is already done or cancelled answer `{ changed: false }` and write no
> activity row rather than throwing. `records.archive()` gained the task cancellation, a `record.archived`
> activity row, and `cancelledTasks` on `ArchiveResult` and in the audit meta — all inside the existing
> control-plane transaction, which locks only last-tier tables. Nothing is deleted: `hf_activity`, `hf_label`
> and `hf_outcome` are the record's history, and a task that was already done stays done.
>
> Two guards the wording did not ask for: every helper that names a record type calls
> `records.types.require()` first, because a `record_type` no app registers is what E002 refuses at the next
> boot (P2's CI lesson); and `outcomes.record` takes an optional `userId` so its activity row has an actor.
> The "a second attempt adds zero rows" assertions live in `activity.test.ts`, `tasks.test.ts` and
> `scores.test.ts`, where the step pool is, rather than in `records.test.ts`, which has none.

**Done:** `pnpm --filter @hyperfixation/core test activity tasks labels outcomes`; `records.test.ts` gains the
open-task cancellation and the "keeps history" assertion over real `hf_activity`/`hf_label` rows.

### C5 — Admin resources for the machinery tables — ✅ Done (deviated — see note)

In `@hyperfixation/admin`, over track D's `resourceFromTable`: `hf_approval` and `hf_run` read-only,
`hf_budget_period` with `budget_usd` editable as an admin *action* (the package's existing shape — it resolves
and refuses, the template reads and renders; `resetSecondFactor` is the precedent for a write). The template's
admin page gains the edit form. "An admin edit to a period's `budget_usd` takes effect at the next gate" —
assert it.

> **Built, and where it differs from the wording above:** the three resources are
> `packages/admin/src/machinery.ts` — `approvals` (`hf_approval`), `runs` (`hf_run`), `budget-periods`
> (`hf_budget_period`) — and `createAdminRouter` **registers them itself**, beside `usersResource`, rather than
> taking them through the `resources` option. They are the framework's own tables; an app has no choice to make
> about them, and the option's comment ("Phase 1 registers none; Phase 2's machinery tables will") now reads as
> the app's own resources. `router.resources.names()` is therefore
> `["users", "approvals", "runs", "budget-periods", …app]`, which is the one Phase 1 assertion that changed.
>
> **Read-only is the absence of an action, not a new flag.** The package has no write path except an action, so
> `approvals` and `runs` ship with `actions: []` and nothing was added to `AdminResource` to say so. A decision
> belongs to `decide()`, which fences it against the run; `hf_run.current_workflow_id` *is* the fencing token.
> An admin editing either table directly would be writing behind the fence.
>
> **Decisions the wording left open.** Lowering `budget_usd` below `spent_usd` is **allowed**: it is not a
> correction but the kill-lever — the next gate compares `spent + reserved + estimate > budget` and refuses
> every further call for the period, which is what an admin watching a runaway month wants. The action touches
> **only the named period's row**: never `spent_usd` (the money is spent either way, and editing it would make
> the gate lie) and never `hf_app_state.budget_usd`, which is only the default copied into each *future*
> period — editing it here would silently change every month to come. Validation is finite and non-negative,
> refused before any lock is taken (`InvalidBudget`); a period with no row is `UnknownBudgetPeriod` rather than
> an insert, since the first gate of a period is the only thing that creates one.
>
> The write is one transaction: `SELECT … FOR UPDATE` on the period in a CTE, the `UPDATE`, then the `hf_audit`
> row (`app.budget_set`, `target_type` `hf_budget_period`, `target_id` the period, `meta` carrying
> `previousBudgetUsd`/`budgetUsd`/`spentUsd`/`reason`) — `app.pause`'s shape, with `resetSecondFactor`'s guard
> and its "actor from the guarded session, not from the form" rule. It takes only the one lock, so it cannot
> deadlock against a gate holding `hf_run` first. `SetBudgetResult` returns the numerics **as stored strings**,
> so a caller sees what `numeric(12,4)` kept rather than what it asked for.
>
> The gate half is driven for real: `@hyperfixation/admin` gained a **test-only** devDependency on
> `@hyperfixation/ai` (no cycle — nothing in the workspace depends on `admin`), and the test opens actual gates
> through `createLlm`/`createProviders`/`fixedCost` over a `MockLanguageModel`, as `ledger-branches.test.ts`
> does. `PROMPTS_DIR` is not on `ai`'s public entry, so the test carries its own one-line prompt at
> `packages/admin/src/test-support/prompts/budget.md`.
>
> **Follow-up, not this chunk:** the template's admin page still has no budget edit form.
> `AdminRouter.actions.setBudget` is the whole server half and is exported; `hyperfixation-template` is a
> separate repo, so the form lands there alongside C6's workspace work.

**Done:** `pnpm --filter @hyperfixation/admin test` — 44 tests, 7 files, 1.7s. The three resources register and
resolve; a member 404s on all four resources including `users`; the budget action refuses a member (writing no
row and no audit line), writes `budget_usd` for an admin while leaving `spent_usd` and `hf_app_state` alone,
audits with the session's admin and both values, and refuses a non-finite, negative or unknown-period budget.
The gate assertion is end-to-end: a gate at the app default opens the month's row and spends it, the next gate
is refused with `BudgetExceeded`, the admin raises the period's budget, and **the same call then goes
through** — then a budget of 0, below what the period spent, refuses the one after it.

### C6 — The workspace — ✅ Done (C6.1–C6.7), **descriptors, template renders**

**Decided (Graham, 2026-09-19):** (1) scope is the **full spec** — home, approval inbox with batch approve and
inline edit, pipeline board, record page with timeline — **split into PRs**: the core descriptors first, then the
template rendering in pieces. (2) The board's **stage list is registered by the app, ordered, per record type**
(a small registry, e.g. `stages` on the record definition, which nothing defines yet); a `stage` value outside the
list shows in an "other" column. The default approval notifier lands here with the URL it needed (P4 is only the
Telegram callback handler; the notifier is the sending side and is C6.3/C6.7).

Graham confirmed (2026-09-18) the recommended shape: `@hyperfixation/core/workspace` exports descriptors, not
React components. `core` stays framework-light — no `react` peer, no `core`-owned server actions to bind — and
`hyperfixation-template` renders them, matching every other Phase 1 package's boundary. The plan's routing
arrow (which reads as components) does not win here; the precedent every other package already set does. UI
is **plain React server components** in the style of the admin pages: `registry/registry.json` has no items and
the template has no Tailwind, so adopting shadcn is a separate later template PR (decided 2026-09-19).

Home (what needs the user: pending approvals assigned to them, open tasks, review-queue count); the approval
inbox with batch approve and inline edit — one `app.approvals.decide` call per submission with `via: 'web'`,
`userId` from the session, and a **client-generated `decisionKey`** so a double-submit replays rather than
refuses; the pipeline board over the mixin's `stage`; the record page with the timeline **grouped by
`run_id`**, labels, outcomes, tasks and the one-click archive (a control-plane call from the web, which is
where it is allowed). Model output is escaped; the plan's own test is a draft containing `<img>` rendered as
text.

**PR breakdown (planner, 2026-09-19; no schema change, no new lock sequence).**

| PR | Repo | Scope | Depends on |
|---|---|---|---|
| C6.1 | core | `RecordDefinition` (`stages`, `title`, `displayColumn`; duplicate stage → `InvalidDefinition`), `@hyperfixation/core/workspace` subpath, `route()`, `nav()`, `approvalPath()`, `draftFields()` | — |
| C6.2 | core | `app.workspace.{home,inbox,board,record,decide}` (control-plane reads; `decide` = `approvals.decide` with `via: 'web'`) | C6.1 |
| C6.3 | workflows + core | `ApprovalNotifier`, `StartWorkerOptions.approvalNotifier` (used by `waitForApproval` when the call passes no `notify`), `ApprovalNotice` gains `assigneeId/recordType/recordId/expiresAt`, `createApprovalNotifier({ appUrl, recipients, send })` | — |
| C6.4 | template | shell, home, record page (timeline by run, labels, outcomes, tasks, archive); keeps the `Signed in as <email>` string the e2e asserts | C6.2 |
| C6.5 | template | inbox: batch approve/reject, inline edit, client `decisionKey` (`crypto.randomUUID()` once per mount) | C6.4, T2c |
| C6.6 | template | read-only board per record type, "Other" column | C6.4 |
| C6.7 | template | `src/notify.ts`, `worker.ts`, `tests/worker-fixture.ts`; e2e: mailpit receives a link | C6.3, C6.4, T2c |

C6.1 ∥ C6.3; C6.5 ∥ C6.6. If T2c slips, C6.5/C6.7 land with a tests-only draft flow. The C5 budget form is
independent of all of these.

**Decisions from the plan (2026-09-19).** The notifier is injected through `startWorker({ approvalNotifier })`
and read from `workerRuntime()` in `waitForApproval` (`defineApp({ notify })` was rejected: flows call
`waitForApproval` from `workflows` and cannot reach the app). **Recipients:** the assignee's `hf_user.email`, else
every `role = 'admin'` user; none → one `console.warn`, no send, `notified_at` still stamped. Messages are text
only. `@hyperfixation/core/workspace` is a second subpath, so `exports.test.ts:27` (asserts exports are exactly
`["."]`), a second api-extractor config and `etc/core-workspace.api.md` follow the `db` migrator precedent
(`packages/db/package.json:25`). Scope fence: no shadcn/Tailwind, no drag-to-stage, no Telegram sending, no
`records.setStage`, no change to `decide()` semantics. **Adversary targets:** the notifier's read inside `ctx.tx`
under a bump race (does a stale attempt get `StaleAttempt` before sending?) and `workspace.decide` with
`admin: false` on an assigned row (assignee rule).

> **C6.1 built (#35), and where it differs from the plan:** `RecordDefinition`/`StageDefinition` are in
> `records.ts`; duplicate stages are refused in `defineApp` at registration (no `defineRecord` exists). The
> `./workspace` subpath carries the functions, but `.` also exports the workspace **types** (`AppWorkspace`,
> `WorkspaceRoute`, `DraftField`, `WorkspaceNavItem`, `WorkspaceRegistries`), because `App.workspace` names them and
> api-extractor errors on a forgotten export. `route()` takes the two registries; a record type beats a page
> registered at the same path, pages match on their whole registered path (also `nav()`'s `href`), and a non-numeric
> or `0` approval id is not a route. `draftFields`: `null`/`undefined` → `""`, `Date` → ISO, containers add no row, a
> bare scalar is `path: "value"`, array paths are `a[0].b`, labels are humanised keys (`contactEmail` → "Contact
> email"; array items suffixed `1`, `2`).
>
> **C6.3 built (#36), and where it differs from the plan:** the notifier and `createApprovalNotifier` live in
> **`@hyperfixation/workflows`** (`approval-notifier.ts`), not `core/workspace`, because C6.3 was built before the
> subpath existed; the URL is an inline `/w/approvals/<id>` and it can re-export from `core/workspace` later.
> `ApprovalNotice` gained `assigneeId`, `recordType`, `recordId` and `expiresAt` (a real `Date`: `db.execute` returns
> timestamps as strings, so the read selects ISO 8601 and converts). The assignee-else-admins recipient query is
> **not** in core; it is C6.7's. **Adversary question answered:** a stale attempt never sends — `step()` throws
> `StaleAttempt` before the notify body runs, and a bump after that read is caught by `ctx.tx`'s `FOR SHARE` on
> `hf_run`, which the recipient read is the first statement of. What remains is a bump after that transaction commits:
> a duplicate message, never a lost one, the same at-least-once trade `notified_at` already carries (tested: a worker
> killed inside `send` leaves one message; the re-entry sends a second and keeps one approval row).
>
> **C6.2 built (#37), and what its adversary found:** `app.workspace.{inbox,home,board,record,decide}` in
> `workspace-views.ts` (plain unlocked SELECTs; the `./workspace` subpath stays pure and synchronous). Two low breaks
> were fixed before merge: a run whose id is the empty string shared a timeline group with the manual writes, and
> `inbox({ userId: null })` counted every unassigned row as `mine`. Everything else held: `decide` with `via` smuggled in
> the options, a truthy non-boolean `admin`, a leaked `decisionKey` and a mixed batch all refuse; identifiers go
> through `quoteIdent`; `record()` deliberately shows every pending approval on the record regardless of assignee.

> **C6.4 built (template #19), and where it differs from the plan:** the demo record type is registered as a
> `RecordDefinition` with a title, `displayColumn` and ordered `stages` (C6.6 needs them). `src/workspace.ts`'s
> `workspaceRequest()` is the one boundary the page and its server actions share: it still calls `src/auth.ts`'s
> `requireSession` and maps the session to `{ userId, admin }`. The screens are in `app/(workspace)/w/[[...path]]/views.tsx`
> with the two server actions (add a label, one-click archive) passed as props, so `react-dom/server` can render them;
> `vitest.config.ts` gained `tests/**/*.test.tsx`. `board`, `inbox`, `approval` and `page` routes render a placeholder
> until C6.5/C6.6. Plain server components, no Tailwind or shadcn; an ESLint `no-restricted-syntax` forbids
> `dangerouslySetInnerHTML` under `app/(workspace)/**` (`eslint.config.js` repeats the shared `sendInTransaction`
> selector, because that rule replaces rather than merges). The workspace e2e is a second `describe` in
> `exit-bar.e2e.ts` and seeds its record in SQL; it was run against a generated app because the template itself
> cannot migrate (`__APP_NAME__` fails the role-name rule) — sign in, home, record page, label, archive, the `manual`
> timeline group, 404s. Findings for core, open: `bootstrapAdmin` takes `{ email }` while `BootstrapAdminOptions` also
> advertises `designatedEmail` (passing only that crashes on `options.email.trim()`); `migrate()` needs the roles to
> exist, nothing outside the `hf` CLI provisions them, and it assumes `public` is owned by the migrator, so a plain
> `CREATE DATABASE` then `pnpm migrate` fails twice first; `RecordView.row` is a raw `Record<string, unknown>` with SQL
> column names, so a template re-implements labelling — a `draftFields`-style flattening would remove that.

> **C6.6 built (template #20):** `board.tsx`, a read-only board at `/w/:recordType` — a column per registered stage in
> order, "Other" only when non-empty, per-column counts, cards linking to the record page; columns wrap on a phone.
> It shows "showing first N" when a full page comes back. Findings for core, open: `BoardView` reports neither the
> limit used nor whether it was hit, so truncation is inferred from a full page; `DEFAULT_BOARD_LIMIT` is exported from
> `@hyperfixation/core` but not from the framework-light `/workspace` subpath the template renders from.

> **C6.7 built (template #23):** `src/notify.ts` — `approvalRecipients()` (the assignee's `hf_user.email`, else every
> `role = 'admin'` user, read through the step's `ctx.tx`) and `approvalNotifier(send?)`, built with core's
> `createApprovalNotifier`, `appUrl` from `requireEnv("APP_URL")` (no new env var) — passed as `approvalNotifier` in
> `worker.ts` and `tests/worker-fixture.ts`. `tests/notify.test.ts` opens a real gate through `draftDemoOutreach` on a
> spawned worker (`notified_at` stamped), then runs the notifier with a capturing `send`: one message, both admins,
> `${APP_URL}/w/approvals/<id>`; the assignee alone when named; no recipients → one warn, no send. The e2e asserts one
> mailpit message to the admin whose link, signed in as the admin, opens that approval. Where it differs: the notifier
> builds its own lazy nodemailer transport (`jsonTransport` when `SMTP_URL` is unset) because `src/email.ts` hard-requires
> `SMTP_URL` for OTPs; `tests/worker-fixture.ts` defaults `APP_URL` to `http://localhost:3000` because `pnpm test`
> and CI set none and a worker would die on `MissingEnv`. **Open:** a **banned admin is still a recipient** (the decided
> rule taken verbatim); decide whether the recipient read should filter banned users.
>
> **C6.5 built (template #21), and its adversary:** `/w/approvals` (batch approve/reject with inline edit, one
> `workspace.decide` call, a `decisionKey` minted in the browser once per mount but seeded from the server render's
> uuid so the field is filled before hydration and with JS off) and `/w/approvals/:id` (the page C6.7's email link opens;
> a decided or invisible approval is a 404). A refusal returns as `?error=` (bounded, rendered as text; only
> `ApprovalBatchRefused` is caught). The e2e drives the **real draft flow**. **Three breaks were found and fixed before
> merge:** (1) `draftFields` joins keys with `.` unescaped and the template's `setAtPath` walked the result through the
> prototype chain, so a draft key `__proto__.polluted` plus an edit set `Object.prototype.polluted` in the server
> process; (2) two fields with the same path (`{"a.b": …, a: {b: …}}`) shared an input name, so an edit landed in the
> wrong field; (3) a stored `\r\n` posted back with the CR stripped, turning an untouched field into an edit. The fix is
> `editablePaths()` in `decide-form.ts`: a field is editable only if its path is unique among the item's fields and
> resolves through **own** properties to an existing scalar (`__proto__`/`constructor`/`prototype` refused); anything
> else renders as read-only text (a literal key containing `.` included), and line endings are normalised on both
> sides of the compare. Everything else held (authorization from the session only, forged/blank/shared keys,
> `?error=` and `returnTo`, item visibility). **Open finding for core:** `draftFields` should emit unambiguous
> paths (an additive `segments: readonly (string | number)[]` on `DraftField`), so the template can make a dotted key
> editable instead of read-only.

**Done:** `pnpm --filter @hyperfixation/core test workspace` (escaping; a batch decision with one edit reaches
`decide()` with that edit and one `decisionKey`); the template's e2e extended — sign in, see the inbox, approve
two drafts with one edit, see the task and label on the record page.

---

## Track T — testing and the template

### T1 — `runFlowSync` — ✅ Done (deviated — see note)

Extract what `hyperfixation-template/tests/flow-restart.test.ts` already does into `@hyperfixation/testing`:
spawn a worker (DBOS cannot relaunch in-process — Phase 1's reason), start the run, wait, bump through the one
path, wait, assert. The plan's three assertions — zero new provider calls, zero new `hf_action_log` rows,
identical `hf_activity`/`hf_task` counts — are all **row counts**, because the cassette lives in the child
process: "zero new provider calls" is *no new `hf_llm_call` row and no `possible_double_charge` flipped*.
`{ restart: false }` opts out with a reason string. The template's test becomes a call to it.

> **Built, and where it differs from the wording above:** the harness is
> `packages/testing/src/run-flow-sync.ts` but its **test and fixtures are in `workflows`**
> (`packages/workflows/src/run-flow-sync.test.ts`, `src/test-support/{insert,unfenced}-flow.ts` and
> `run-flow-sync-fixture.ts`), because a fixture flow needs `defineFlow`/`step`/`startWorker` and `testing`
> cannot import `workflows` — that dependency only runs the other way (`spawn-worker.ts`). So the file the
> spec named, `packages/testing/src/run-flow-sync.test.ts`, does not exist and `--filter @hyperfixation/testing
> test run-flow-sync` matches nothing; the command is
> `pnpm --filter @hyperfixation/workflows test run-flow-sync`.
>
> `runFlowSync(harness, flow, input, options?)` takes the caller's already-built handles
> (`{ pool, client, worker, start, tables? }`) for the same reason: starting a run needs `runsStart` and
> `getClient`. `harness.start` is typed on a structural `FlowRef` (`{ name, queue }`), so a caller widens its
> `Flow<I, O>` once — the cast the template's loop already carries. Opting out is
> `restart: { skip: "<reason>" }`, not `{ restart: false }`: the reason is mandatory by type.
>
> **The second fencing channel is a name-prefix match on text.** A refusal a flow *caught* arrives as
> `spawnWorker`'s marker and is checked with `assertNoFencingFailure` after each attempt. One it did **not**
> catch propagates out of the workflow and only reaches the parent as `hf_run.error`, which `defineFlow` wrote
> as `${name}: ${message}` — so the harness matches `/^(UnfencedWrite|ControlPlaneInWorkflow): /` on that
> string and raises `FencingFailureInTest` with an empty `detail`. **Verified:** an uncaught `UnfencedWrite`
> inside a step reaches `defineFlow`'s catch with `name` intact through `DBOS.runStep`; no rewrap, no fallback
> to message matching needed.
>
> Counted: `RESTART_COUNTED_TABLES` (`hf_llm_call`, `hf_action_log`, `hf_activity`, `hf_task`, `hf_audit`,
> `hf_approval`) plus `harness.tables`, plus one non-table key `hf_llm_call.possible_double_charge` — the
> "zero new provider calls" half. Counts are read on `harness.pool`; there is no `applicationUrl` field.
> Attempt 1's workflow id is the bare run id (`attemptWorkflowId` only suffixes from 2), and the wait keys on
> `current_workflow_id` with `status <> 'running'` rather than the template's `finished_at IS NOT NULL`, so a
> `waiting` or `paused` flow settles too; both attempts must settle at the same status.
>
> **The harness counts rows, not values.** `upsert-flow.ts`, reused as the passing fixture, upserts
> `count = count + 1`: its row count is unchanged across the restart (which is what `runFlowSync` asserts) but
> the counter reads 2, because a bumped attempt is a new workflow id and every step body genuinely re-runs. A
> flow that must be value-idempotent needs its own assertion on top of `runFlowSync`.

**Done:** `pnpm --filter @hyperfixation/workflows test run-flow-sync` — 4 tests: a keyed upsert flow passes
with `attempts: 2`; a fixture flow with a plain `INSERT` rejects with `RestartChangedCounts` naming
`test_insert: 1 -> 2`; a fixture flow writing outside `ctx.tx` rejects with `FencingFailureInTest`
(`UnfencedWrite`) in ~1 s, not a timeout; `restart: { skip }` runs one attempt. `flow-restart.test.ts` in the
template green over it — T2's half, the template being a separate repo.

### T2 — The demo registrations and `tests/contract.test.ts` — ✅ Done (C0, T0, T2a–T2d landed)

**Split, as planned 2026-09-19 (each its own PR, across two repos):** C0 (core: the fixture provider, `score()` with a
step context — landed, #30) and T0 (template: `demo_note` adopts the mixin — landed, template #12) first; **T2a**
`flow-restart.test.ts` over every registered flow via `runFlowSync`; **T2b** the source, resolver, spec, scorer, the
collect/resolve/score flows, `src/llm.ts`, prompts, fixtures, the schedule tick in `worker.ts`, `Dockerfile` copying
`fixtures/`; **T2c** the draft flow (`demoDraft` approval type with the contact-allowlist validators, the email channel
with `dedupes: false`, `tasks.create`, `activity.record`); **T2d** `tests/contract.test.ts`, `CLAUDE.md` and the
replace-demo skill. The template's CI builds core's `main`, so each core change merges before the template PR that
needs it. Decisions taken: fixtures are served only when **no** provider key is set (never per provider — a missing
OpenAI key must not silently produce fake drafts); the email channel uses nodemailer's `jsonTransport` when
`SMTP_URL` is unset (mailpit stays the exit bar's); the allowlist is a constant, not a new env var.

> **T2a and T2b built (template #14, #15), and where they differ from the plan:** `flow-restart.test.ts` runs
> `runFlowSync` over `app.flows.all()` with `it.each`, plus a values test (`runFlowSync` counts rows, so a scorer
> that found nothing to score would pass identically). `recordDemoNote` is **retired**; the three flows take
> registration names as input (`{ source }`, `{ resolver, source }`, `{ scorer }`); `demo_note` gains a nullable
> `contact_email` (template migration `0002`); the schedule tick is 30 s against three 10-minute schedules and is
> per-process (`lastFired` is not persisted; every flow it starts is keyed); the test worker does not run it; the
> test seeds `hf_app_state.budget_usd` because a fresh database has no row and the gate refuses outright.
> Findings for core (2)–(4) closed by core #38; (1) `hf_source_run` grows on every restart by design (`loadSource` books each
> call), so keep it out of `runFlowSync`'s counted tables; (2) `llm.run` returns only the output, so
> `hf_score.llm_call_id` stays null for LLM-assigned scores; (3) `LlmRunOptions.schema`'s `JSONSchema7` is not
> re-exported from `@hyperfixation/ai`, so a template cannot type a hoisted schema constant without deriving it;
> (4) `resolveBatch` leaves `done` false forever when a batch fills its `limit` with `review` rows (they stay
> scannable), so a `while (!done)` loop never ends — the demo flow caps at 1000 batches.

> **T2c built (template #16), and where it differs from the plan:** `src/approvals/demo-draft.ts` (the `demoDraft`
> type and allowlist validators), `src/channels/email.ts` (`dedupes: false`; `jsonTransport` when `SMTP_URL` is
> unset), `src/flows/draft-demo-outreach.ts`, `prompts/draft.md`, fixtures. The flow drafts for up to `limit` records
> at or above `minScore` (defaults 10 / 0.5), picked by score, not one named record; it has **no schedule** (a second
> run over the same record drafts a second email, so nothing fires it on a clock); a draft that fails the approval
> schema writes a `draft.refused` activity row and skips the record. `zod` 4.6.5 is added with a workspace override
> that also collapses better-auth's zod onto core's copy. Findings for core, closed by core #38: (5) `ActionChannel.send`
> receives `dispatch.request: unknown` (`actions.ts:8`), so every channel casts — an `ActionChannel<Request>` generic
> would remove it; (6) `JSONSchema7` still not re-exported (same as (3)); (7) `assertDecidable` reports "has no
> hf_approval row" when an id is a numeric string, a misleading message for a type mismatch.

> **T2d built (template #17, #18):** `tests/contract.test.ts` runs collect → resolve → score → draft → approve →
> send → task → activity on the fixtures with `runFlowSync` and its restart opted out (`flow-restart.test.ts` is
> that assertion over the same flows); "no real provider" is asserted as nothing billed (every `hf_llm_call` at 0
> tokens and cost, `spent_usd` 0), because `hf_llm_call` has no provider column. A provider key or `SMTP_URL` in the
> environment **fails the suite under `CI` and skips it with a warning elsewhere** (#18). `CLAUDE.md` and the
> replace-demo skill name every demo file. Findings for core, open: `hf_score` has `spec_version` but no spec name,
> so two specs on one record type are indistinguishable in that table; `@hyperfixation/testing` has no
> `waitForRun`-style helper (two template tests each hand-roll the same ~15-line poll).
>
> **Core #38 closed findings (2)–(7):** an optional `onCall` on `LlmRunOptions` hands the caller the `hf_llm_call` id
> (a scorer returns `llmCallId` and `scores.write` fills `hf_score.llm_call_id`); `JSONSchema7` is re-exported;
> `ActionChannel<Req>` is generic; `resolveBatch`'s `done` is `rows.length < limit` or nothing moved out of the scan
> (`review` does not count as movement); `assertDecidable` names a type mismatch. Finding (1) stays by design.

The shape doc's loop, one registered example per file: a sample **source** (fixture JSON → the COPY loader),
the **resolver** on `normalized_name`, a sample **spec** and a **scorer** (`llm.run`, `score:<record_id>`),
a **draft flow** (`llm.run` `draft:<record_id>` → `waitForApproval` type `demoDraft`, whose Zod schema carries
the **contact-allowlist validators** — no URLs, no phone or email outside an allowlist, a length cap — that
Phase 6's letter channel copies → `actions.perform` on an **email channel** to `SMTP_URL` → `tasks.create`
follow-up → `activity.record`), and a **label** from the record page. Every step keyed; every write through
`ctx.tx`. `tests/contract.test.ts` runs the loop on the fixtures with the cassette; `flow-restart.test.ts`
now covers four flows instead of one. The replace-demo skill and `CLAUDE.md` are updated to name the new
files. `prompts/` gets its first two files.

Open question 5 is decided: the provider registry hands out a **fixture provider** (a `MockLanguageModel` fed
from `fixtures/llm/*.json`) when no key is set, and the demo's fixtures ship with the template. This is what
makes the exit bar's "no extra provider calls" countable in CI without a real key.

**Prerequisite landed (C0).** The core half of the above is in, so T2 only has to ship fixtures and
registrations:

- **The fixture provider.** `createProviders({ fixtures: { dir } })` serves a `LanguageModelV4` reading
  `<dir>/<promptName>.json`, whose shape is
  `{ "responses": [ { "when": { "userTextIncludes": "acme roofing" }, "json": {…} }, { "text": "…" } ] }`.
  Selection is the first entry whose `when` matches the last user message's text (case-insensitive), else the
  first entry with no `when`, else `FixtureMissing` — never a silent default, like `CassetteExhausted`. A
  `json` entry is returned as JSON text, which is what the `schema` path parses. Tokens default to 0, so
  `cost_usd` is 0 and a fixture run never moves `spent_usd`. The file is read per call, like a prompt file.
- **Only when *no* key at all is set**, not per provider: an app with Anthropic configured and an OpenAI key
  missing still throws `UnknownModel`, because silently serving fake drafts in production is worse than the
  crash. Explicit `models` entries still win. One `console.warn` per process says fixtures are being served.
- **The join.** `llm.run` now puts `providerOptions: { hyperfixation: { runId, key, promptName, promptHash } }`
  on every call. Verified: the AI SDK forwards it to `doGenerate` unaltered on both the plain and the
  `Output.object` path, and a real provider reads only its own namespace.
- **`score(record, criteria, ctx)`.** `ScorerDefinition.score` takes a third `StepContext` argument, without
  which a scorer cannot call `llm.run` at all. Type only; core still has no scorer runner.

**Done:** `pnpm test` in a generated app — `contract.test.ts`, `flow-restart.test.ts` over every registered
flow, `compose-envs.test.ts` — green; `hf check` green; `rg -i demo` finds only the allowed files.

### T3 — The template's telemetry half — ✅ Done (template #22)

`instrumentation.ts` registers Langfuse's span processor when the keys are set; `REQUIRED_ENV` is unchanged
(the three vars are already in it).

**Done:** `compose-envs.test.ts` unchanged and green; `next build --webpack` with the keys empty still
prerenders.

> **Built (template #22):** `instrumentation.ts` gates on the three `LANGFUSE_*` names being non-empty and then
> `await import("@hyperfixation/workflows")` for `registerLangfuse`, below the existing `NEXT_RUNTIME === "nodejs"`
> guard, with a module-level flag so a second `register()` cannot register twice. The env names are repeated locally
> rather than imported as `LANGFUSE_ENV`, because importing the constant would load the OTel SDK into every web process to
> learn telemetry is off (`registerLangfuse` re-checks, so core stays the authority). `tests/instrumentation.test.ts`
> spies on `registerLangfuse` with `vi.mock` (OTel registration is process-wide and would leak across files that run real
> workers). `next build --webpack` prerenders with empty keys and with dummy keys, with no Langfuse network attempt.
> Sentry's `TODO` is left. No core findings.

---

## Exit — Phase 2 exit assembly — ✅ Done (template #24 merged)

The bar, from the plan: *the demo run approves two drafts with one edit, mailpit receives the send, a
follow-up task appears, a label is recorded; pausing mid-run stops the next flow at its next step and resuming
finishes it with no extra provider calls; a 30-minute soak shows a flat connection count under the per-role
limit.*

As with Phase 1, **write the bar as a test** in the template's e2e suite (`tests/e2e/demo-loop.e2e.ts`, same
harness as `exit-bar.e2e.ts`): the run, the inbox, the two approvals with one edit through the real UI, the
mailpit API for the send, the record page for the task and the label; then `POST /api/status/pause` with the
write token mid-run, assert the run reaches `paused` and the workflow SUCCESS within one step, resume, assert
`done` with `hf_llm_call` count unchanged — redeploy case 4's assertions, driven through the app instead of
the harness. The **soak is manual** and stays manual: thirty minutes of the demo loop on a schedule under
`pnpm dev` + `pnpm worker`, sampling
`SELECT usename, count(*) FROM pg_stat_activity WHERE usename = 'hf_<app>' GROUP BY 1` once a minute; flat
means the same number every sample, and the number the plan budgets is **web 5 + web DBOSClient 2 + step 8 +
control 2 + DBOS 5 + LISTEN 1 + lock 1 = 24**, under the role's `CONNECTION LIMIT 25`. Record the observed
number here.

**Done:** `pnpm test:e2e` green in a generated app for both e2e files; the soak's numbers in this document;
`pnpm -w typecheck lint test api-extractor` green in core with the new file and test counts recorded.

> **Built (template #24, merged), 2026-09-19.** `tests/e2e/demo-loop.e2e.ts` and a shared
> `tests/e2e/harness.ts` (used by both e2e files). Run in a generated app on the dev cluster (`hf new` from the worktree,
> mailpit :1025/:8025): `pnpm test:e2e`, 2 files, 11 tests, green twice (~60 s); `typecheck`, `lint`, `pnpm test` (13 files,
> 72 tests) and `next build --webpack` green.
>
> **Core**, clean clone of `origin/main` at `4c1cb4a`: `pnpm -w typecheck lint test api-extractor` green, 44 tasks;
> **91 test files, 596 tests (595 passed, 1 skipped)** — admin 7/44, ai 19/50, auth 5/38, cli 11/66 (1 skipped), core 15/124,
> db 12/129, testing 3/16, workflows 19/129.
>
> **Soak (manual, 30 min):** `pnpm dev` + `pnpm worker`, 30 s tick against the three 10-minute schedules. The draft
> flow was **not** fired, so the loop churned collect/resolve/score; every fifth minute the two records' scores were nulled
> as `postgres` so score had real work (collect 5→7, resolve 8→10, score 4→6, `hf_llm_call` 28→32, 0 failed runs, clean
> SIGTERM). Per-minute `hf_<app>` connection counts: `8 3 3 3 3 3 3 3 3 3 4 4 3 4 3 3 3 3 3 3 4 4 4 4 3 3 3 3 3 3`.
> **Not flat, and it cannot be**: `pg.Pool` closes idle clients after 10 s, so the count tracks activity rather than holding
> the budget. A parallel 5 s sampler (320 samples) gives the real peak: **max 9** (3×135, 4×74, 5×32, 6×26, 8×33, 9×20),
> no upward drift, under the budgeted 24 and the role's `CONNECTION LIMIT 25`. **The bar's word "flat" should be restated
> as "bounded: no upward drift and a peak under the limit"**, which is what this run shows.
>
> **Where it differs from the plan:** (1) **`instrumentation.ts` needed `/* webpackIgnore: true */` on the dynamic import
> (a T3 bug):** `serverExternalPackages` does not reach the instrumentation hook, so webpack followed
> `@hyperfixation/workflows` into `pg` and 500'd every page under `pnpm dev`; CI's `next build` had not caught it.
> Registration still runs with `LANGFUSE_*` set. (2) Both approvals are on **the same record**: the draft flow's select
> takes the best-scoring unarchived row on every attempt, so two distinct records cannot both survive to their sends.
> (3) The paused flow is a `resolve`-queue flow started into the paused app — deterministic, since a pause deliberately
> leaves that queue alone. Core findings: none new.

**Phase 2 is complete (2026-09-19).** Every chunk in the tracks above has landed and the exit bar's assertions run in
the template's e2e suite. What is still open, none of it blocking:
- **Decided (Graham, 2026-09-19):** the bar's "flat connection count" is **restated as "bounded: no upward drift and a
  peak under the limit"** (the soak measured a peak of 9 against a budget of 24 and a limit of 25, and cannot be flat
  because `pg.Pool` closes idle clients after 10 s); and the notifier's recipient read **excludes banned users**.
- **Landed (2026-09-19), one PR each:**
  - **Core #46:** `DraftField` gains `segments: readonly (string | number)[]` (object keys verbatim, indexes as numbers);
    `BoardView` gains `limit` and `truncated` (`LIMIT limit + 1`, then trim, so it is the same snapshot as the cards);
    `DEFAULT_BOARD_LIMIT` is on the `/workspace` subpath too (declared in `workspace.ts`, re-exported from
    `workspace-views.ts`, because the other direction would pull `pg` into the framework-light subpath).
  - **Core #48:** `bootstrapAdmin`'s `email` is now optional and falls back to the designation in force
    (`designatedEmail`, else `HF_BOOTSTRAP_EMAIL`), and `BootstrapRefused("no-designation")` is finally thrown;
    `migrate()` **refuses once** (it does not provision) with a preflight for the application role, `CREATE` on the
    database and `CREATE` on `public`, naming every missing item and `hf migrate` / `provisionRoles()` — a bare
    database used to cost three runs (`drizzle` schema, `public`, the `dbos -r` role).
  - **Core #49:** migration `0007_score_spec_name` adds a nullable `hf_score.spec_name` and replaces
    `hf_score_run_key_uq` with `(run_id, key, spec_name)`; `writeScore` fills it, and the replay and timeline keys now
    include the spec name (two specs scored in one step used to collapse into one row); `latestScores()` is
    `DISTINCT ON (spec_name)`. `@hyperfixation/testing` gains `waitForRun(pool, runId, status | predicate, { timeoutMs, intervalMs })`
    whose `RunNeverMatched` prints the last observed row. **Known and accepted, nothing being deployed yet:** a run in
    flight across the deploy has pre-0007 rows with `spec_name` NULL, so a replay writes a duplicate score row and
    timeline entry; the record mixin's `score`/`score_explanation`/`spec_version` still hold whichever spec wrote last
    (`latestScores` works around it); legacy NULL-spec rows bucket together and order by `id`.
  - **Template #25 and #26:** the notifier excludes a user only while `banned IS TRUE AND (ban_expires IS NULL OR ban_expires > now())`
    — a banned assignee falls through to the admins, an `assigneeId` with no row still notifies nobody; the C5 admin
    budget form sits on a `budget-periods` row (`scope: "row"`), refuses a blank input (`Number("")` is 0, a zeroed
    ceiling being the kill-lever), and is covered by `admin-budget`, `admin-budget-render` and an e2e over period
    `1999-01`. **Template #27:** the board reads `view.truncated`/`view.limit` and drops its local `BOARD_LIMIT`.
  - **A lesson recorded:** core #46 made the two `BoardView` fields required, which turned template main red (the
    template's CI builds core's `main`, and `tests/board-render.test.tsx` built a `BoardView` literal), and #26 and #11
    merged into it. **Before merging a core PR that changes an exported type, run the template's typecheck and tests
    against the PR's build** (check out the branch in the core checkout, `pnpm turbo build`, then the template).
- **Open finding for core:** `packages/auth/src/policy.ts:91` refuses on `banned === true` alone and ignores
  `ban_expires`, so a lapsed ban still 404s the user out of `/admin` and `/w` — the opposite of what the notifier now
  does. **Template, unrelated:** PR #11 (the $10 dev budget note) merged.

---

## Parallelism

| Track | Package(s) | Can start | Must land by | Status |
|---|---|---|---|---|
| **L — ledger** (L1–L5b) | `ai` (+ one `startWorker` hook in `workflows` for L2) | chunk 0 | T2 needs L1; Exit needs all | ✅ L1–L5b done |
| **P — approvals and actions** (P1–P4) | `workflows` | chunk 0 | T2 needs P1, P2; Exit needs all | ✅ P1–P4 done |
| **C — core** (C1–C6) | `core`, `db` (C2), `admin` (C5) | chunk 0 | T2 needs C1–C4; Exit needs C6 | ✅ C1–C6 done |
| **T — testing and template** (T1–T3) | `testing`, `hyperfixation-template` | chunk 0 for T1; the others as listed | Exit | ✅ T1–T3 done |

**Execution model.** Chunk 0 is one PR by one head, first. After it the three tracks are genuinely
independent — they touch disjoint packages, and the one shared file each will touch is its own package's
`etc/*.api.md`. The two places they meet are stated, not discovered: L2 adds one registration call to
`startWorker()` (track P's package), and P2 needs `defineApp` to hand `decide()` a schema lookup (track C's
package). Land L2 and P2's `core` half as small PRs on their own so neither track waits on the other's chunk.
T2 is the integration chunk and waits on both — start it when L1, P1, P2 and C4 are in, not before; a demo
written against stubs would be rewritten.

**Merge friction to plan for.** One migration, in chunk 0; if a track needs a column after that, it is its
own nullable `ADD COLUMN` migration (P1's task key, `origin_ref`, already shipped in chunk 0). Since #5
`migrate.test.ts` derives the expected set from the journal, so a new migration no longer touches it, but the
journal baseline (`migrations-journal.baseline.json`) still grows. API reports churn on every chunk that
exports anything — Phase 1's Still open 7 — and `core.api.md` will churn most; regenerate in the same PR, and
expect a reordering-only diff in a neighbour's report from a dependency change (`zod` into `workflows` is the
likely trigger, the way `admin`'s `kysely` peer was).

**Regenerate API reports from a clean clone, not the working tree.** api-extractor orders string-literal
unions by type-creation order, which an incremental local build does not reproduce: chunk 0's PR failed CI
because a worktree build ordered three existing status unions (`hf_approval`, `hf_llm_call`, `hf_run`)
differently from CI's. Fresh clone, `pnpm install --frozen-lockfile`, `pnpm turbo build`, `api-extractor run`,
copy `temp/<pkg>.api.md` over `etc/`, and confirm `pnpm turbo api-extractor` passes there before pushing.

## Gate case → chunk map

| Case | First passes at | Lives in |
|---|---|---|
| mixin snapshot; delete guard over `hf_label`/`hf_outcome`/`hf_record_link`; E002 over the new tables | 0 | `packages/db/src/` |
| `ledger-branches` re-pointed; prompt-hash test | L1 | `packages/ai/src/` |
| Langfuse unset/fake-exporter | L2 | `packages/workflows/src/start-worker` test, `packages/ai/src/` |
| `ledger-crash` (four sub-cases) | L3 | `packages/ai/src/ledger-crash.test.ts` |
| `kill-switch` (both halves) | L4 | `packages/ai/src/kill-switch.test.ts` |
| `budget` (b), (c), (d) | L5a | `packages/ai/src/budget.test.ts` |
| `budget` (a) | L5b | same file, from `it.todo` |
| `ActionUncertain` + task; step (4) task once | P1 | `packages/workflows/src/actions.test.ts`, `reconcile.test.ts` |
| Zod refusal; assignee rule; `hf_activity` fatal; `batch_id` | P2 | `packages/workflows/src/approvals.test.ts` |
| the ten approvals negatives | P2, P3 (see P3's table) | `packages/workflows/src/approvals.test.ts`, `wait-for-approval.test.ts` |
| Telegram callback replay | P4 | `packages/workflows/src/` |
| registries, spec, schedule-under-pause | C1 | `packages/core/src/` |
| loader (duplicate external id; unfenced `COPY` refused) | C2 | `packages/db/src/loader.test.ts` |
| resolution (four cases + `EXPLAIN`) | C3 | `packages/core/src/resolution.test.ts` |
| activity/tasks/labels/outcomes; `records.archive` cancels tasks, keeps history | C4 | `packages/core/src/` |
| admin machinery resources; budget edit takes effect at the next gate | C5 | `packages/admin/src/` |
| workspace escaping; inbox batch with one edit | C6 | `packages/core/src/workspace*.test.ts`; template e2e |
| `runFlowSync` three fixtures | T1 | `packages/testing/src/run-flow-sync.test.ts` |
| `contract.test.ts`; `flow-restart` over four flows | T2 | template `tests/` |
| the demo-loop e2e; the soak | Exit | template `tests/e2e/demo-loop.e2e.ts`; this document |

## Readings taken (stated so they can be argued with before they are code)

1. **When `ActionUncertain` fires.** The plan: "a channel with no idempotency support throws
   `ActionUncertain`, the row becomes `uncertain`, and a task … is created, rather than re-sending". The
   exit bar needs the first send of an email — a channel with no idempotency support — to *go out* and reach
   mailpit. So the throw is on **re-entry only**: a `started` row already exists under another attempt (or
   this one, after DBOS recovery), and the channel cannot dedupe, so nothing is sent and a human confirms.
   The first dispatch of a row this attempt inserted always proceeds. Under this reading a non-deduping
   channel gets at most one send per row ever, which is the stronger guarantee than the ledger's "at most one
   extra".
2. **The lock-order tier of the eight new tables.** The plan fixes `hf_run → hf_budget_period →
   (hf_llm_call | hf_approval | hf_action_log) → other app tables` and names no others. `hf_activity`,
   `hf_task`, `hf_label`, `hf_outcome`, `hf_score`, `hf_source_*`, `hf_record_link` sit in the **last** tier,
   with "other app tables", so `decide()`'s `hf_activity` insert (after its `hf_approval` updates) and
   `actions.perform`'s task insert (after its `hf_action_log` update) already comply. `budget.test.ts` (c)
   is where a violation would show as `40P01`.
3. **`record_id` is `text` on the new tables**, as it is on `hf_approval` and `hf_action_log` — v1's table
   says `bigint`, but Phase 1 chose `text` and the delete guard's `OLD.id::text` cast assumes it. Consistency
   with the four tables that exist wins over v1's column type.
4. **`hf_activity.run_id` is null for web-side writes** (a label, an outcome, a manual task) and the run's id
   for step-side ones; the timeline groups the former under "manual".

## Open questions

Questions only Graham can answer are **blockers** for the chunk named; the rest carry a default this document
orders against, to be overturned cheaply if wrong.

1. **Decided 2026-09-18, via `/brainstorm` — an injected clock, not a database-level override.** None of
   the three original SQL-level candidates won. `llm.run`'s gate takes a `clock: () => Date` that defaults
   to real time, and only `@hyperfixation/testing` — a package production code never imports — ever
   constructs a non-default one. **Built 2026-09-19 with one correction:** the clock is handed to
   `createLlm({ clock })` in `@hyperfixation/ai`, **not** to `ControlPlane.attach()`, which lives in
   `@hyperfixation/core` and is invisible to `ai`; and the worker knob is `WorkerControl.clockAt` (a pinned
   ISO instant) rather than `clockOffsetMs`, which would have drifted by however long the spawn took. The
   live advance is as decided: a `clock <iso-timestamp>` stdin message alongside `release`, no restart,
   which is what lets case (a) move the clock while the cassette still has the call parked. Full reasoning
   and the rejected alternatives are under L5b.
2. **Decided 2026-09-18 — descriptors, template renders.** `@hyperfixation/core/workspace` ships descriptors,
   not React components. Components would make a core release an upgrade (the template's `/w` page says
   exactly that) at the cost of `react` as a peer of `core`, server actions the app must bind (the
   `createSessionGuard` precedent), and a much larger `core.api.md`. Descriptors keep the Phase 1 shape and
   put the whole UI in the template, where a core release cannot change it — the shape every other Phase 1
   package already chose, overriding the plan's routing arrow. The `registry/` shadcn directory supplies the
   UI pieces the descriptors render through.
3. **Decided 2026-09-19 (P4) — Telegram in Phase 2 without the Phase 6 bot** is the `via: 'telegram'` callback
   handler and its nonce-as-`decisionKey` replay test, and no message is ever sent. If Graham wants a real
   bot in Phase 2, `hf_telegram_link` and a `TELEGRAM_BOT_TOKEN` in `REQUIRED_ENV` come forward with it.
4. **Defaulted (C1) — the plan's "actions" registry is the existing `channels` registry.** It is already
   contract surface in `core.api.md`, and "the choice is the flow's, made per action type at registration"
   reads as *which channel*. Renaming it costs an API-report diff and nothing else, so this is cheap to
   overturn.
5. **Decided 2026-09-18 — fixture provider by default.** `hf up` on a laptop with `ANTHROPIC_API_KEY` empty
   must still run the loop, and the exit bar's "no extra provider calls" is only countable against something
   deterministic. The provider registry hands out a **fixture provider** — a `MockLanguageModel` fed from
   `fixtures/llm/*.json` — when no key is set, and the demo's fixtures ship with the template. This is what
   keeps the exit-bar e2e running in CI without a real key.
6. **Resolved in chunk 0 — `hf_task` needed an idempotency key for "one task per uncertain row, once".** v1's
   columns (`record_type`, `record_id`, `title`, `due_at`, `owner_id`, `done_at`, `cancelled_at`, `origin`)
   give `reconcile()` nothing to `ON CONFLICT` on. Default: an `origin_ref text null` column with a partial
   unique index `(origin, origin_ref) WHERE origin_ref IS NOT NULL`, set to the action-log row's id — shipped
   in chunk 0's migration. C4 adds `"<runId>:<key>"` refs for flow-created tasks on the same index.
7. **Defaulted — Sentry is not Phase 2's.** The template's `instrumentation.ts` says `TODO(phase 2)` for
   both Sentry and Langfuse; the plan's Phase 2 text names only Langfuse, and Phase 3's `hf new` provisions
   the DSN. Change the TODO's label, not the phase.
8. **Closed by L4 — `kill-switch.test.ts` lives in `ai`**, where `llm.run` is; the plan's verification line
   now names it under the `ai` filter and no longer under `workflows`.

## Carried from Phase 1's "Still open"

- **3 — `hf_activity`'s insert in `decide()`** → ✅ closed by P2 (#19): fatal, same rule as `hf_audit`.
- **5 — migration-count literals** → obsolete: #5 derives the expected set from the journal, so a new migration never edits `migrate.test.ts`; only `migrations-journal.baseline.json` grows.
- **7 — API-report churn** → every track; `core.api.md` most. Undecided as before whether `auth.api.md`'s
  surface should be narrowed; nothing in Phase 2 makes it worse.
- **8 — `hf_invitation`** untouched by Phase 2.
- **New, from this pass — `records.archive()` on a mixin-less record table fails with `42703`** in a
  generated app today. Closed on the `db` side by chunk 0; the template half landed as template #12 (`demo_note` adopts the mixin, with a `records-archive` test that fails with the `42703` when the migration is withheld).

## Verification

Core, at every chunk: `pnpm -w typecheck && pnpm -w lint && npx turbo run test --force && pnpm -w
api-extractor` against a real pg17 (`HF_TEST_DATABASE_URL` as CI sets it). Baseline at `4d08ac2`: 61 files,
360 tests, ~3m16s, all green (since grown well past 70 files and 450 tests; CI takes about 6 minutes); `redeploy-case-1` is load-sensitive (Phase 1's note) — rerun it alone before
chasing it. Named gates, from the plan's verification line as amended by open question 8:
`pnpm --filter @hyperfixation/ai test ledger-crash budget kill-switch`,
`pnpm --filter @hyperfixation/workflows test approvals actions reconcile`,
`pnpm --filter @hyperfixation/core test resolution`, `pnpm --filter @hyperfixation/db test loader`. App:
`pnpm test` and `pnpm test:e2e` in a generated app, `hf check`, `docker compose -f docker-compose.prod.yml
config`. Expect the suite's wall clock to grow materially — L4's 100×100, L5a's 200 iterations, C3's 200k
rows, L3's 1,000-row loop — and record the new number at Exit as Phase 1 did.

Manual, because automation cannot see it: the 30-minute soak (query above); a real provider call once, by
hand, against each configured provider so the cost table's numbers are checked against a real bill line.

## Risks

- **L1 refactors the function under seven gate cases.** Mitigated by making those cases the done-check and
  by refusing any change to what they assert. If a case has to change what it asserts, that is a finding,
  not a rebase.
- **Open question 1 decides production SQL.** Every candidate changes the gate's stamp expression, which
  `redeploy-case-12` and `ledger-branches` sit on; whichever shape wins, run both before and after.
- **The `workflows` ↔ `core` cycle constrains P2.** `decide()` cannot import the registry; the schema lookup
  is a parameter. An implementer who reaches for the import will get a build error, which is the cheap
  failure; the expensive one is duplicating the registry in `workflows`.
- **C6 is the largest chunk.** Its shape is now decided and split into C6.1–C6.7. Ordered last in its track for that reason; T2 does
  not depend on it, so the loop can be proven from the harness before the UI exists.
- **Suite runtime.** Phase 1's 3m16s is about to double or worse. The 200k `EXPLAIN` case and the 100×100
  kill switch are the ones to measure first; if either is over a minute, gate it behind a `describe.skipIf`
  on an env var the CI job sets, and say so in this document.
- **Reading 1 (`ActionUncertain` on re-entry only) is a reading.** If the plan meant "never send through a
  non-deduping channel at all", the exit bar's mailpit assertion cannot pass without an idempotent email
  channel, which does not exist. Worth one adversary pass before P1.

**Recommended adversary targets before Phase 2 starts** (run the `adversary` agent against these, in order):
(a) reading 1 and P1's re-entry branch — construct a double send through a non-deduping channel;
(b) open question 1's chosen shape — a gate whose stamp and insert disagree, and the restart-while-parked
window in (i); (c) P2's validate-before-write with a schema lookup that throws — does the transaction still
roll back through the tag-asserting helper, or can a thrown lookup escape it; (d) the lock order with the
new tables under `budget.test.ts` (c) — any Phase 2 write that locks a last-tier table before a third-tier
one, in `records.archive()`'s task cancellation especially.
