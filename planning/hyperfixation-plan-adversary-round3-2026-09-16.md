# Adversary review, round 3: hyperfixation-plan-2026-09-15.md

**Date:** 2026-09-16. Four parallel adversary passes against the plan's own named "recommended adversary targets before Phase 2" from round 2's rework — fence coverage, `enqueueInTransaction` grants/rollback, derived-budget races, and SIGTERM/process-exit timing. All grounded in `@dbos-inc/dbos-sdk@4.27.6` source, and mostly against live Postgres 17 reproductions (noted per finding).

**Implementation status added 2026-09-17** against the tree at `6deac13`. Each finding carries a marker for
whether its fix is built and where; the findings are unchanged.

| Finding | Fix status |
|---|---|
| 1 — `UnfencedWrite` blind to out-of-context callbacks | ✅ Done — the rule is inverted and in production: the step pool refuses any non-`SELECT` on a client not currently tagged by `ctx.tx` (57a1f5e, over the classifier from eeb6d57). Gate: `fence.test.ts` case (vi) drives all six shapes, including the adversary's two, and asserts each one's `SELECT` still passes. |
| 2 — `records.archive()` has no fence story | ✅ Done (deviated) — control-plane operations with `assertNotInWorkflow()` and a 30 s `SET LOCAL lock_timeout` (7296766); `records.archive()` itself at 496b903. Case (vii) is split: `fence.test.ts` drives stand-ins and the `55P03` bound, `packages/core/src/records.test.ts` drives the real `archive()`, because `@hyperfixation/db` cannot import `core`. |
| 3 — workflow-body and transitive-helper writes | ✅ Done — same mechanism as 1; `fence.test.ts` case (vi) shapes (c) and (d). ⬜ The lint hint half is track A and unbuilt; `flow-restart.test.ts` is Phase 2. |
| 4 — the migrator never grants the app role `dbos` access | ✅ Done — `dbos schema -s dbos -r hf_<app>` is step 3 of the five-step migrator, and E006 checks both privileges at boot (a08e41f). Gate: redeploy case 10, both directions. |
| 5 — a swallowed error can report a decision that did not persist | ✅ Done — one commit helper asserting the `COMMIT` command tag, throwing `CommitLost`, rolling back and releasing the client with the error (7296766). Gate: `fence.test.ts` case (v), plus both kill-before-`COMMIT` halves of redeploy cases 1 and 8 (5b25f21). 🚧 The rule it protects is only half-populated: `decide()` writes `hf_audit` fatally, and `hf_activity` does not exist yet (see the plan's step 4). |
| 6 — a redeploy destroying a backlog through false budget failures | ✅ Done — the reservation is scoped to rows whose `workflow_id` is their run's live attempt on a `running` run, so a dead attempt's row stops reserving in the bump's own transaction (753e923). Gate: redeploy case 12, the 50-run scenario exactly as traced (060aaef). |
| 7 — no month-rollover mechanism | ✅ Done — `hf_budget_period`, one row per UTC calendar month, stamped on the ledger row and billed to that row's period (753e923, table at a3190e5). ⬜ The period-boundary assertions are Phase 2's `budget.test.ts` and `withClock` is deliberately out of Phase 1. |
| 8 — lock-order inversion and unlocked re-entry | ✅ Done — one lock order `hf_run → hf_budget_period → ledger`, completion updates the budget row first, re-entry happens inside the gate transaction under the period lock, and `reconcile()`'s drift read is a plain `SELECT` with no `FOR UPDATE` (753e923, a359f06). ⬜ The 200-iteration `40P01`/`55P03` stress is Phase 2's `budget.test.ts`. |
| 9 — no re-entry guard on `DBOS.shutdown()` | ✅ Done — module-level `shuttingDown` boolean, second delivery logs and returns (fe04650). Gate: redeploy case 11, first half. |
| 10 — a rejecting `shutdown` swallowed by Sentry's listener | ✅ Done — non-`async` listener, explicit `.then(ok, err)` with both arms calling `process.exit`, watchdog armed synchronously before any await (fe04650). Gate: redeploy case 11, second half. |

**All ten fixes are built.** What is outstanding is gate coverage, not mechanism: round-2 finding 1's own
scenario (redeploy case 7) is unwritten, and findings 7 and 8 have Phase 2 assertions by design. One new gap
was found during the build that round 3 did not attack — a pause/resume liveness race on redeploy; it is
recorded in the plan's Risks and in the execution order's chunk 13.

## Finding 1 — HIGH, live-reproduced: `UnfencedWrite` detection is blind to writes from callbacks whose async context was created outside the step

**Target attacked:** fence coverage (a) — the harness's step-context detection.

Normal `await`/`.then()`/`setTimeout`/`setImmediate`/`process.nextTick` all correctly propagate Node's `AsyncLocalStorage` and get caught by the harness — verified live, not assumed. The real escapes are resources **created outside the step and driven from outside it**:

- A module-level buffered writer (e.g. an activity-logging helper that batches writes on a `setInterval` flusher) — a write pushed while inside a step, flushed later from the interval callback, runs with `DBOS.isInStep() === false`. Live-reproduced: the harness never fires.
- An event listener **registered** inside a step but **emitted** from outside it — `EventEmitter.emit` runs synchronously in the emitter's own context, not the registration context. Live-reproduced (two independent escape shapes).

The harness's rule is a *positive* filter on step context, so it can't be made complete by patching more `await` shapes — only a *negative* rule (fail any non-`SELECT` on the app pool not inside `ctx.tx`, regardless of ALS) closes this. The plan's own Phase 1 gate case 7 only tests the in-context case and stays green with the escape shipped — a tautological test.

## Finding 2 — HIGH: `records.archive()` has no defined fence story, and calling it from inside an open step transaction can deadlock undetectably

**Target attacked:** fence coverage (a), continued.

`records.archive` is core API, is a listed caller of `approvals.decide`, and is absent from the plan's list of helpers that write through `ctx.tx`. `decide()`'s own transaction takes `FOR UPDATE` on `hf_run`/`hf_approval`, never the `current_workflow_id` fence. If a step calls `records.archive` (nothing forbids it, no lint catches it — it's a legitimate public import), and that step is inside its own open `ctx.tx` on the same run, `decide()`'s `FOR UPDATE` conflicts with the step's held `FOR SHARE` on the same `hf_run` row. **Postgres's deadlock detector cannot see this** — it only traverses lock-wait edges between backends, and the second half of the cycle is a JS `await`, not a database wait. The step hangs until the 60s drain abandons it and the worker dies on the 75s watchdog, with no attributable cause in the logs.

In the non-nested case (archive called from a step but outside `ctx.tx`), `decide()`'s writes to `hf_approval`/`hf_audit`/`hf_activity` commit unfenced while the calling step's own fence can independently throw `StaleAttempt` — both outcomes are currently undefined, not designed. Note also: in tests, `decide()`'s own writes go through the wrapped app pool inside step ALS context but outside `ctx.tx` — meaning the plan's own harness, as specified, would flag core's own shipped `decide()` API with `UnfencedWrite` if called from a step. The behavior is genuinely undefined, not merely untested.

## Finding 3 — MEDIUM-HIGH: unfenced writes from the workflow body (outside any step) are covered by neither the test harness nor the lint rule

**Target attacked:** fence coverage (a), continued.

The harness keys on `isInStep()`; inside a `defineFlow` body (not yet inside a `step()` call), `isInStep()` is false and `isWithinWorkflow()` is true — no `UnfencedWrite` fires. The lint backstop (`no-restricted-imports` on the DB client) is scoped to files under `src/flows/**`, but `no-restricted-imports` only constrains the *importing* file. A helper file one directory over (`src/lib/records.ts`, not under `src/flows/**`) that imports the DB client directly and is itself imported by a flow is lint-legal and harness-invisible. Since "every new attempt runs the flow function from the top," this is precisely the double-write window Finding 1 of round 2 was meant to close, reopened through an unguarded seam.

## Finding 4 — CRITICAL, live-reproduced: the migrator never actually grants the app role access to the `dbos` schema — the worker cannot launch

**Target attacked:** `enqueueInTransaction`'s grant question.

The plan asserts "the migrator's grant step gives the application role DML on `dbos.*`" — no such step exists. The actual migrator sequence (core migrations → app migrations → `dbos schema -s dbos` → triggers → `hf_grant_ro`) grants nothing on the `dbos` schema: `dbos schema -s dbos` only applies grants when invoked with a `-r <role>` flag, which the plan's invocation omits. Confirmed against real DBOS source: zero `GRANT` statements anywhere in DBOS's own system-schema migrations — nothing rescues this by default.

**Blast radius is worse than the question asked.** `startWorker()` connects to the system database as the same narrow app role with `runMigrations: false`. **The worker itself cannot launch**, not just `runs.start`/`decide()`. Every Phase 1 gate fails at boot. Live-reproduced: `permission denied for schema dbos (42501)`.

**Fix, verified live:** the migrator step needs to be `dbos schema -s dbos -r hf_<app>` — confirmed this grants exactly what's needed (`USAGE` on the schema plus `INSERT`/`SELECT`/`UPDATE` on `dbos.workflow_status` at minimum for `enqueueInTransaction`; the full grant set is needed for the worker's broader system-table access) and confirmed `enqueueInTransaction` succeeds once applied. This must run on every deploy (not just the first), since `ALTER DEFAULT PRIVILEGES` only covers objects created later by the same role — an SDK upgrade adding new system tables would silently be under-granted otherwise.

## Finding 5 — HIGH, live-reproduced: a silently-swallowed error inside `decide()`'s transaction can report an approval as decided while nothing persists

**Target attacked:** `enqueueInTransaction`'s rollback-handle question.

`enqueueInTransaction`'s returned handle carries no pending-vs-committed state (confirmed by reading its actual shape: `{systemDatabase, workflowUUID}`, nothing else). Live-tested after a rollback: `getStatus()` returns `null` (indistinguishable from "row never existed" or "garbage collected"); `getResult()` hangs forever rather than rejecting.

Worse: Postgres returns a `ROLLBACK` command tag for a `COMMIT` issued on an already-aborted transaction, and node-pg **does not throw** on that — confirmed live. `decide()`'s final step is a bare "commit," with no check of the result. If any statement between the enqueue and that commit fails and gets swallowed anywhere (the audit/activity inserts are the realistic candidate, since those are routinely made non-fatal), `decide()` returns success to the caller while the approval stays `pending` in the database, the run never resumes, and — traced through `reconcile()`'s actual scan predicates — **nothing catches this until the approval silently expires days later**, converting what looked like a successful decision into a quietly expired one.

**One-line detector the plan currently lacks:** assert the command tag of the final `COMMIT` is `'COMMIT'`, not just that the call didn't throw.

## Finding 6 — HIGH, traced exactly: a redeploy can destroy an entire backlog of in-flight runs through false budget failures

**Target attacked:** derived-budget starvation from dead-attempt `started` rows.

`reconcile()`'s ledger-hygiene step exempts `running` runs from ever having orphaned `started` rows released — by design, since a `running` run's current attempt might still need to reach that ledger key. But the derived reservation (`SUM(estimated_cost_usd) WHERE status='started'`) has no run-filter, no age-filter, and no month-filter — it's global. Traced exact failure sequence: many runs bumped by a redeploy queue up behind limited concurrency; each holds a stale `started` row from its dead attempt; the first run to reach a budget check after the redeploy sees the *entire backlog's* phantom reservations, trips `BudgetExceeded`, and — since that's unretried and terminal per the plan's own design — **dies permanently**. Its death frees a queue slot; the next queued run hits the same wall. The whole backlog can self-destroy this way, killing runs whose real spend was zero, while real month-to-date spend stays well under budget.

The plan's own stated framing ("errs toward refusing, the safe direction") is backwards for this specific failure: refusal here isn't a deferral, it's permanent, unretriable destruction of work — worse than the double-charge risk the ledger was built to bound. Existing gate tests don't catch this because they only construct orphans on already-`failed` runs, never on a `running` backlog under concurrency pressure.

## Finding 7 — HIGH, confirmed by direct textual search: there is no month-rollover mechanism anywhere in the plan

**Target attacked:** derived-budget month rollover.

`month` appears in exactly one place in the whole document (the `hf_app_state` schema) — no step anywhere advances it or resets `spent_usd`. As specified, `spent_usd` is a monotone all-time counter compared against what's meant to be a *monthly* budget: the first month cumulative spend crosses `budget_usd`, `BudgetExceeded` fires forever afterward, permanently, for every subsequent month.

If a rollover is added in the only two plausible places (a scheduled reset, or lazily on first write of a new month), a call whose ledger row is inserted before midnight but whose provider response lands after it gets billed to the wrong month — traced exact timing — with no correction path (the plan's own drift-reporting design explicitly never corrects, only reports). The reservation sum is also unbounded across months: a stale orphaned row surviving from month N is charged in full against month N+1's fresh budget, since `reserved` (unlike `spent`) carries no time scope at all — the two sides of the core budget inequality are effectively measured in different units of time.

## Finding 8 — Mixed: the plan's stated reasoning for lock-ordering safety is factually wrong, but the specific race it argues against still holds (for a different reason) — and a real, live-reproduced deadlock exists nearby

**Target attacked:** step-6/gate lock ordering.

The plan claims "both [the budget gate and the ledger's completion step] take `hf_app_state` first" — traced the actual lock acquisition order in both paths and this is false; they're inverted (gate: `hf_run` → `hf_app_state` → `hf_llm_call`; completion: `hf_run` → `hf_llm_call` → `hf_app_state`, last). Despite the wrong reasoning, the specific race the plan argues against (a torn read between reserved and spent) does not occur — live-verified — because the completion step is one atomic transaction, so a concurrent reader only ever sees fully-before or fully-after, never a split state. Correct conclusion, wrong justification.

But the inverted lock order **does deadlock**, live-reproduced with two concurrent transactions on the same `(run_id, key)`, caught by Postgres's real deadlock detector this time (unlike Finding 2's undetectable JS-level version). This specific instance isn't reachable through `llm.run` alone (the run-level fence closes it), but the plan's own `reconcile()` ledger-hygiene step reads `hf_app_state.spent_usd` for its drift calculation without specifying how — if that read takes `FOR UPDATE` (consistent with the plan's own stated doctrine that the singleton lock is what makes the reservation math sound), the same cycle reopens with no fence protecting it.

**Separate, related gap on the same surface:** when an abandoned ledger row re-enters the reservation pool (the replay path), that transition happens in a transaction that takes no lock on `hf_app_state` at all, while other runs' gates compute reservations that briefly omit it — allowing the true reserved+spent total to exceed `budget_usd` by up to a full queue's worth of estimates without tripping `BudgetExceeded`, contradicting the plan's own claim that "a newly inserted `started` row is the reservation; nothing else records it."

## Finding 9 — LOW, live-reproduced: `DBOS.shutdown()` has no re-entry guard; a second SIGTERM can make it reject

**Target attacked:** process-exit timing, part 2 (double SIGTERM).

Two SIGTERM deliveries in quick succession both invoke the plan's handler (Node re-fires the listener per delivery; DBOS's own internal `#shuttingDown` flag is never checked by `shutdown()` itself). Both reach `pool.end()` on the same connection pool; node-postgres throws "Called end on pool more than once" on the second call, which propagates up and makes the second `DBOS.shutdown()` call **reject**. Currently masked only by timing luck — the first call's `process.exit(0)` usually wins the race before the second's rejection is observed — not a designed safety margin, and fragile to any additional `await` in the shutdown path.

## Finding 10 — MEDIUM, live-reproduced: when `DBOS.shutdown()` does reject, the plan's literal `await shutdown(); process.exit(0)` shape does not reach the exit call as described, and can hang for the full 75s watchdog window

**Target attacked:** process-exit timing, part 3 (shutdown rejecting).

The rejection is genuinely reachable (Finding 9 demonstrates one path; an unbounded telemetry-exporter flush inside `shutdown`'s internals is another, untested but plausible given the plan wires Langfuse/OTLP into the same worker). Two measured outcomes when it happens: with no rejection handler installed, Node kills the process immediately at exit code 1 — functionally fine, just not the mechanism the plan describes. But with any `unhandledRejection` listener registered — and Sentry's default integration registers exactly one, which the plan's own error-tracking setup would install — the rejection is **silently swallowed**, the continuation that would call `process.exit(0)` never runs, and the process hangs until the 75s watchdog fires, costing 75 of the 90 available seconds on every occurrence.

**Fixed handler shape, verified live to close both Finding 9 and Finding 10:** a boolean re-entry guard, an explicit `.then(onSuccess, onRejection)` branch instead of a bare `await`, and a non-`async` top-level listener so no continuation can be silently dropped. The watchdog's own arming point and the 75s bound are otherwise confirmed correct as specified — no change needed there, aside from documenting that a synchronous block in a step body can delay the *signal handler's own entry*, which nothing in Node or DBOS can prevent (an inherent single-threaded-event-loop limitation, not a design flaw to fix).

## Held, verified this round (carry forward, don't re-litigate)

- SIGTERM arriving before `DBOS.launch()` completes at any of five tested timing points — no stranded advisory lock, no hang, in every case.
- The advisory lock is released correctly (in under 300ms) even on uncontrolled process death (default SIGTERM, no handler), not just on a clean `process.exit(0)`.
- A second shutdown call does not truncate the first's drain, and does not close the pool while workflows are still genuinely running.
- The 75s watchdog arms correctly as specified (synchronous, before any `await`) and its bound holds regardless of how long the drain or telemetry flush take.
- Drizzle's relational query API (`db.query.*`) has no write methods — not a fence-bypass surface.
- `ctx.tx`'s internal transaction-context propagation does not lose step-context (`isInStep` stays true inside it).
- Step `timeoutMS`/abort signals are advisory only, confirmed — a timed-out body keeps running inside the same async-context frame, so the harness still catches its writes.
- The `BEFORE DELETE` guard trigger executes within the writing transaction and correctly aborts a fenced write it rejects.
- No torn/split read of the reserved-vs-spent budget state is possible across the ledger's completion transaction, despite the plan's wrong stated reasoning for why.
