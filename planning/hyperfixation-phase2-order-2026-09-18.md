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

Nothing Phase-2-scoped has landed since Phase 1 closed. The only markers other than ⬜ below are on pieces
Phase 1 pulled forward and that Phase 2 completes rather than introduces.

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
3. **The workspace's package boundary is undecided, and it is the largest chunk.** The plan routes
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

### 0 — The eight tables, the mixin, one migration — ✅ Done (db half; T0 template half not started)

`@hyperfixation/db`: Drizzle definitions and `0004_machinery.sql` (one migration, every table) for
`hf_source_run`, `hf_source_record`, `hf_record_link`, `hf_score`, `hf_activity` (**with `run_id text null`**,
the timeline column the plan adds over v1), `hf_task`, `hf_label`, `hf_outcome`, with v1's columns and the
`(record_type, record_id)` composite index on each polymorphic one. `hfRecordColumns()` — `created_at`,
`updated_at`, `archived_at`, `stage`, `score`, `score_explanation`, `spec_version`, `normalized_name`; every
column nullable or defaulted, none unique — plus the snapshot test that pins it. `migrate.test.ts`'s three
literals go `"4"` → `"5"`; the journal baseline grows.

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

### L2 — Langfuse wiring — ⬜ Not started

`startWorker()` registers Langfuse's OTel span processor when `LANGFUSE_*` are set and nothing when they are
not (the worker fixture's `skipOpenTelemetrySetup: true` stays); `trace_id` lands on the row. The web half is
the template's `instrumentation.ts` (T3). Sentry's `TODO(phase 2)` beside it is **not** this chunk's — the
DSN is provisioned by Phase 3's `hf new`, and the plan's Phase 2 text does not name Sentry (open question 7).

**Done:** with the keys unset, `startWorker()` registers no processor (assert on the OTel global); with a
fake in-memory exporter, one `llm.run` produces a span whose attributes carry the four telemetry fields and
whose id is the row's `trace_id`.

### L3 — `ledger-crash.test.ts` (re-scoped) — ⬜ Not started

Same-version only: `killAt(key, 'after-checkpoint')` → zero extra calls; `'before-checkpoint'` → one extra,
`possible_double_charge = true`; a 1,000-record loop yields 1,000 rows; a second `llm.run` in one run with the
same `key` and a different `input_hash` throws `LedgerKeyCollision`. Redeploy case 3 already proves the first
of these across a relaunch and `ledger-branches` the last in-process; this file exists because the plan's
Phase 2 verification names it, and it should **reuse** case 3's fixture rather than duplicate it.

**Done:** `pnpm --filter @hyperfixation/ai test ledger-crash`.

### L4 — `kill-switch.test.ts` — ⬜ Not started

100 runs each orphaning one `started` row by failing, then 100 `reconcile()` passes: 100 `abandoned` rows,
derived reservation 0, the period's `spent_usd` unchanged, `BudgetExceeded` still fires at the budget. Then
the case redeploy case 9 deferred here: an `abandoned` row revisited by a later attempt of a **`waiting`** run
(decide it) is flagged, set back to `started` under the current attempt, counted in the reservation, and moved
to `ok` once.

Lives in `ai` — it drives `llm.run` — though the plan's verification line lists `kill-switch` under the
`workflows` filter (open question 8, trivial).

**Done:** `pnpm --filter @hyperfixation/ai test kill-switch`. Budget the runtime: 100 passes each scanning
`hf_run` is seconds, not minutes, but say so in the file's timeout.

### L5a — `budget.test.ts` (b), (c), (d) — ⬜ Not started

(b) *re-entry through the gate*: an `abandoned` `$1` row on a `waiting` run, period at `budget − $0.50`,
`decide()` → the replaying attempt's `llm.run` throws `BudgetExceeded`, row stays `abandoned`. (c) *lock-order
stress*: 200 iterations of concurrent gates, completions, `reconcile()` passes and `decide()` calls across 8
runs, zero `40P01`, zero `55P03`. (d) *the finding-8 inversion*: a completion and a gate on the same
`(run_id, key)` driven in lock-step from two connections cannot deadlock. None of these touch the clock.

**Done:** `pnpm --filter @hyperfixation/ai test budget` green for (b)–(d), with (a) `it.todo` naming open
question 1.

### L5b — `withClock` and `budget.test.ts` (a) — ⬜ Not started, **shape decided 2026-09-18 via `/brainstorm`**

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

---

## Track P — approvals and actions completion (`@hyperfixation/workflows`)

### P1 — `ActionUncertain`, the task, `reconcile()` step (4)'s task — ⬜ Not started

`ActionChannel` gains the declaration of whether it dedupes on `idempotencyKey`. `actions.perform`: on
re-entry of a `started` row (the branch `actions.test.ts` calls "takes a started row left by a dead attempt
back under this one") with a channel that does not dedupe, throw `ActionUncertain`, set the row `uncertain`,
insert one `hf_task` (`origin = 'flow'`) and one `hf_activity` row, all inside the same `ctx.tx` — never
re-send. `reconcile()` step (4)'s action half gains its task (`origin = 'sweep'`), **exactly once per row
across passes**, which needs an idempotency key on `hf_task` that v1's columns do not give it (open
question 6). The lock-order tier for `hf_task`/`hf_activity` is under "Readings taken".

**Done:** `actions.test.ts` extended — a non-deduping channel re-entered yields `uncertain` + one task + no
second `send`; a deduping channel re-entered re-sends with the same `idempotencyKey` (today's behaviour,
now conditional); `reconcile.test.ts` step (4) — one task per orphaned action row, unchanged across three
passes. Redeploy cases 1 and 8 still green (`stubChannel` is re-declared as deduping).

### P2 — `decide()` completion: Zod, the assignee rule, `hf_activity`, `batch_id` — ⬜ Not started

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

**Done:** `approvals.test.ts` — a batch with one edit that parses is written with `edited_draft`; an edit
that fails the schema refuses the whole batch naming the row; assignee mismatch refused; an admin decides an
assigned row; one `hf_activity` row per decided approval; a `hf_activity` insert made to fail (a `BEFORE
INSERT` trigger installed by the test, the same trick the audit case uses) leaves the approval `pending`,
creates no `dbos.workflow_status` row, and a retry with the same `decisionKey` succeeds.

### P3 — The approvals negative suite — ⬜ Not started

The plan's list, mapped against what `approvals.test.ts` and `wait-for-approval.test.ts` already prove:

| Case | At `4d08ac2` | Lands at |
|---|---|---|
| batch with one edit | edit stored, unvalidated | P2 |
| stale row refuses the whole batch with per-row reasons | ✅ | — |
| assignee mismatch refused | ⬜ | P2 |
| replayed `decisionKey` returns the first result, writes nothing | ✅ | — |
| crash inside `waitForApproval` creates no second row | ⬜ (`killAt('approval', 'in-tx')` on the step, then a second attempt) | P3 |
| two pending approvals on one run; deciding the second resumes with the second's decision, leaves the first pending (3b) | ⬜ | P3 |
| `dbos workflow delete` on the run's rows before deciding loses nothing (3c) | ⬜ | P3 |
| resume workflow runs under the current version and is enqueued exactly once when `decide()` is called twice concurrently | ⬜ | P3 |
| `hf_audit` insert made to fail → throw, `pending`, no DBOS row, retry succeeds | ⬜ | P3 |
| `decide()` on X while a step holds `ctx.tx` inside `waitForApproval`'s `INSERT … ON CONFLICT` on X: no `40P01` | ⬜ | P3 |

The last one has no `killAt` park point: `'in-tx'` parks after the fence statement, before the `INSERT`.
Either add a park point after the insert, or write it in `fence.test.ts`'s style — two raw connections issuing
the real statements in the real order, no DBOS — which is what that case is actually about. Prefer the
latter; it lives in `workflows` (it needs `decide()`), not in `db`.

**Done:** `pnpm --filter @hyperfixation/workflows test approvals` — every row of the table green.

### P4 — Telegram `via`, the default notifier, expiry — ⬜ Not started, **shape depends on open question 3**

Expiry is already built (`reconcile()` step (5), `expiresInMs`), so "expiry" here is only what the notifier
says. The plan's Telegram sentence — "callbacks carry the approval id and a per-message nonce as
`decisionKey`" — is a `decide()` caller with `via: 'telegram'` and `decisionKey = <approvalId>:<nonce>`, and
the bot that would send the message is Phase 6's (`hf_telegram_link` is a Phase 6 table; no `TELEGRAM_*` var
is in `REQUIRED_ENV`). The thin slice this document orders: the callback handler and its replay test, with
no bot. A default email notifier ("link straight to the item") needs the workspace's URL for an approval,
which is C6's — so the notifier ships with C6, and until then `notify` stays app-supplied as it is today.

**Done:** a callback handler test — the same `(approvalId, nonce)` delivered twice decides once; a nonce for
an approval that is no longer pending returns `ApprovalBatchRefused`, not a 500.

---

## Track C — registries, loader, resolution, the workspace (`@hyperfixation/core`, `db`, `admin`)

### C1 — Registries with behaviour, `pages`, `schedules`, the outcome spec — ⬜ Not started

`defineSource`, `defineResolver`, `defineScorer` (today's `{ name, recordType? }` definitions grow the
function they name); `pages` and `schedules` registries (a schedule starts a run — "scheduled flows check
`paused` first and return without starting a run" — never a durable sleep); `defineSpec` — a typed, versioned
criteria definition, `spec_version` on `hf_score` and on the mixin. "`actions`" in the plan's registry list
is read as the existing `channels` registry (open question 4). Every registry keeps `createRegistry`'s
duplicate/unknown errors. `core.api.md` will grow a great deal here; regenerate it in the same PR.

**Done:** `registry.test.ts` extended for the new kinds; a spec test — scoring against version 2 leaves
version 1's `hf_score` rows and writes new ones; a schedule under a paused app starts no run.

### C2 — The COPY loader and `hf_source_run` — ⬜ Not started

In `@hyperfixation/db` (the layout puts "COPY loader" there): `pg-copy-streams` into a per-run `UNLOGGED`
staging table, `INSERT … SELECT DISTINCT ON (source, external_id) … ON CONFLICT DO UPDATE` into
`hf_source_record` with `payload_hash`, all inside one `ctx.tx` (the classifier counts `COPY` as a write and
the tagged client allows it — `fenced-client.test.ts` already proves the classification). `hf_source_run`
bookkeeping: `rows_in`, `rows_new`, `rows_changed`.

**Done:** `pnpm --filter @hyperfixation/db test loader` — a batch with a duplicate external id loads once;
the staging table is gone after commit; an unchanged payload leaves `last_seen` moved and `payload_hash`
equal; a `COPY` from outside `ctx.tx` is refused with `UnfencedWrite`.

### C3 — Resolution — ⬜ Not started

A flow on queue `resolve` (concurrency 1). In-batch exact-key grouping first, so duplicates within a batch
produce one record; exact-key join (plus phone and email candidates); then fuzzy, record by record so later
records see earlier creates, the candidate query under `SET LOCAL pg_trgm.similarity_threshold = <t>` using
`normalized_name % $1` (both statements inside `ctx.tx`); re-ranked in process; uncertain → `status =
'review'`; each record in a `SAVEPOINT`, a throw marks it `error` with `attempts + 1` and the batch completes;
a `manual`/`human_confirmed` link is never re-decided; a changed payload updates the linked record in place.

**Done:** `pnpm --filter @hyperfixation/core test resolution` — v1's four cases (in-batch duplicates → one
record; changed payload on a manual link updates the record and leaves the link; a throwing `create()` marks
that record `error` and the batch completes; `EXPLAIN` of the candidate query at 200k rows shows the GIN
index and no seq scan). Give the 200k case its own `describe` and timeout, and measure it once — it is the
first test in the suite whose cost is the data, not the DBOS launch.

### C4 — Activity, tasks, labels, outcomes, scores — ⬜ Not started

The step-side helpers (`activity.record`, `tasks.create`, `scores.write` — every one a write through `ctx.tx`,
synchronously inside it, per the run-model rule) and the web-side ones (`labels.add`, `outcomes.record`,
`tasks.complete` — web writes on the web's pool, no fence, but `assertNotInWorkflow()` so a flow cannot reach
them). `hf_activity.run_id` set from the run context on the step side and null on the web side; that column
is what C6's timeline groups by. `records.archive()` gains "cancels open tasks", which v1 lists and Phase 1
did not build (no table).

**Done:** `pnpm --filter @hyperfixation/core test activity tasks labels outcomes`; `records.test.ts` gains the
open-task cancellation and the "keeps history" assertion over real `hf_activity`/`hf_label` rows.

### C5 — Admin resources for the machinery tables — ⬜ Not started

In `@hyperfixation/admin`, over track D's `resourceFromTable`: `hf_approval` and `hf_run` read-only,
`hf_budget_period` with `budget_usd` editable as an admin *action* (the package's existing shape — it resolves
and refuses, the template reads and renders; `resetSecondFactor` is the precedent for a write). The template's
admin page gains the edit form. "An admin edit to a period's `budget_usd` takes effect at the next gate" —
assert it.

**Done:** `pnpm --filter @hyperfixation/admin test` — the three resources register; a member 404s on all
three; the budget action refuses a non-admin, writes for an admin, and a gate opened after it reads the new
value.

### C6 — The workspace — ⬜ Not started, **open question 2 decided: descriptors, template renders**

Graham confirmed (2026-09-18) the recommended shape: `@hyperfixation/core/workspace` exports descriptors, not
React components. `core` stays framework-light — no `react` peer, no `core`-owned server actions to bind — and
`hyperfixation-template` renders them, matching every other Phase 1 package's boundary. The plan's routing
arrow (which reads as components) does not win here; the precedent every other package already set does. UI
pieces the descriptors need come from `registry/` (the shadcn registry), pulled into the template the way any
shadcn item is.

Home (what needs the user: pending approvals assigned to them, open tasks, review-queue count); the approval
inbox with batch approve and inline edit — one `app.approvals.decide` call per submission with `via: 'web'`,
`userId` from the session, and a **client-generated `decisionKey`** so a double-submit replays rather than
refuses; the pipeline board over the mixin's `stage`; the record page with the timeline **grouped by
`run_id`**, labels, outcomes, tasks and the one-click archive (a control-plane call from the web, which is
where it is allowed). Model output is escaped; the plan's own test is a draft containing `<img>` rendered as
text. The default approval notifier (P4) lands here with the URL it needed.

**Done:** `pnpm --filter @hyperfixation/core test workspace` (escaping; a batch decision with one edit reaches
`decide()` with that edit and one `decisionKey`); the template's e2e extended — sign in, see the inbox, approve
two drafts with one edit, see the task and label on the record page.

---

## Track T — testing and the template

### T1 — `runFlowSync` — ⬜ Not started (needs chunk 0)

Extract what `hyperfixation-template/tests/flow-restart.test.ts` already does into `@hyperfixation/testing`:
spawn a worker (DBOS cannot relaunch in-process — Phase 1's reason), start the run, wait, bump through the one
path, wait, assert. The plan's three assertions — zero new provider calls, zero new `hf_action_log` rows,
identical `hf_activity`/`hf_task` counts — are all **row counts**, because the cassette lives in the child
process: "zero new provider calls" is *no new `hf_llm_call` row and no `possible_double_charge` flipped*.
`{ restart: false }` opts out with a reason string. The template's test becomes a call to it.

**Done:** `pnpm --filter @hyperfixation/testing test run-flow-sync` — a keyed upsert flow passes; a fixture
flow with a plain `INSERT` fails on the second attempt with the count diff in the message; a fixture flow
writing outside `ctx.tx` fails with the fencing failure, not a timeout. `flow-restart.test.ts` in the
template green over it.

### T2 — The demo registrations and `tests/contract.test.ts` — ⬜ Not started (needs L1, P1, P2, C1–C4, T1)

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

**Done:** `pnpm test` in a generated app — `contract.test.ts`, `flow-restart.test.ts` over every registered
flow, `compose-envs.test.ts` — green; `hf check` green; `rg -i demo` finds only the allowed files.

### T3 — The template's telemetry half — ⬜ Not started (with L2)

`instrumentation.ts` registers Langfuse's span processor when the keys are set; `REQUIRED_ENV` is unchanged
(the three vars are already in it).

**Done:** `compose-envs.test.ts` unchanged and green; `next build --webpack` with the keys empty still
prerenders.

---

## Exit — Phase 2 exit assembly — ⬜ Not started

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

---

## Parallelism

| Track | Package(s) | Can start | Must land by | Status |
|---|---|---|---|---|
| **L — ledger** (L1–L5b) | `ai` (+ one `startWorker` hook in `workflows` for L2) | chunk 0 | T2 needs L1; Exit needs all | ⬜ |
| **P — approvals and actions** (P1–P4) | `workflows` | chunk 0 | T2 needs P1, P2; Exit needs all | ⬜ |
| **C — core** (C1–C6) | `core`, `db` (C2), `admin` (C5) | chunk 0 | T2 needs C1–C4; Exit needs C6 | ⬜ |
| **T — testing and template** (T1–T3) | `testing`, `hyperfixation-template` | chunk 0 for T1; the others as listed | Exit | ⬜ |

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
   the three original SQL-level candidates won. `llm.run`'s gate takes its `clock: () => Date` through
   `ControlPlane.attach()`, the same handle-passing seam `runs.start`/`decide()`/`reconcile()` already use;
   it defaults to real time, and only `@hyperfixation/testing`'s worker module — a package production code
   never imports — ever constructs a non-default one. `WorkerControl.clockOffsetMs` sets it at spawn; a new
   stdin message (`clock <iso-timestamp>`, alongside the existing `release`) advances it live, without a
   restart, which is what lets case (a) move the clock while the cassette still has the call parked. Full
   reasoning and the rejected alternatives are under L5b.
2. **Decided 2026-09-18 — descriptors, template renders.** `@hyperfixation/core/workspace` ships descriptors,
   not React components. Components would make a core release an upgrade (the template's `/w` page says
   exactly that) at the cost of `react` as a peer of `core`, server actions the app must bind (the
   `createSessionGuard` precedent), and a much larger `core.api.md`. Descriptors keep the Phase 1 shape and
   put the whole UI in the template, where a core release cannot change it — the shape every other Phase 1
   package already chose, overriding the plan's routing arrow. The `registry/` shadcn directory supplies the
   UI pieces the descriptors render through.
3. **Defaulted (P4) — Telegram in Phase 2 without the Phase 6 bot** is the `via: 'telegram'` callback
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
6. **Defaulted (P1) — `hf_task` needs an idempotency key for "one task per uncertain row, once".** v1's
   columns (`record_type`, `record_id`, `title`, `due_at`, `owner_id`, `done_at`, `cancelled_at`, `origin`)
   give `reconcile()` nothing to `ON CONFLICT` on. Default: an `origin_ref text null` column with a partial
   unique index `(origin, origin_ref) WHERE origin_ref IS NOT NULL`, set to the action-log row's id. Decide
   it in chunk 0 so it is in the one migration.
7. **Defaulted — Sentry is not Phase 2's.** The template's `instrumentation.ts` says `TODO(phase 2)` for
   both Sentry and Langfuse; the plan's Phase 2 text names only Langfuse, and Phase 3's `hf new` provisions
   the DSN. Change the TODO's label, not the phase.
8. **Defaulted — `kill-switch.test.ts` lives in `ai`**, where `llm.run` is; the plan's verification line
   lists it under the `workflows` filter. Update the plan's line when the file lands.

## Carried from Phase 1's "Still open"

- **3 — `hf_activity`'s insert in `decide()`** → P2, fatal, same rule as `hf_audit`.
- **5 — migration-count literals** → chunk 0 takes them to `"5"`; any later Phase 2 column takes them further.
- **7 — API-report churn** → every track; `core.api.md` most. Undecided as before whether `auth.api.md`'s
  surface should be narrowed; nothing in Phase 2 makes it worse.
- **8 — `hf_invitation`** untouched by Phase 2.
- **New, from this pass — `records.archive()` on a mixin-less record table fails with `42703`** in a
  generated app today. Closed by chunk 0/T0; worth a test in the template that archives a demo record.

## Verification

Core, at every chunk: `pnpm -w typecheck && pnpm -w lint && npx turbo run test --force && pnpm -w
api-extractor` against a real pg17 (`HF_TEST_DATABASE_URL` as CI sets it). Baseline at `4d08ac2`: 61 files,
360 tests, ~3m16s, all green; `redeploy-case-1` is load-sensitive (Phase 1's note) — rerun it alone before
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
- **C6 is the largest chunk and its shape is undecided.** Ordered last in its track for that reason; T2 does
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
