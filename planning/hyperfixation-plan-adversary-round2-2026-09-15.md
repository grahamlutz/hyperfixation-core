# Adversary review, round 2: hyperfixation-plan-2026-09-15.md

**Date:** 2026-09-15. Three parallel adversary passes against the plan's own named "recommended adversary targets before Phase 2" — the reconciler's concurrency fence, the ledger's cross-version race, and `decide()`'s commit-to-enqueue window. All grounded in `@dbos-inc/dbos-sdk@4.27.6` source and, where noted, a live Postgres 17 reproduction.

**Implementation status added 2026-09-17** against the tree at `6deac13`. Each finding now carries a marker
saying whether its fix is built, with the commit that built it. The findings themselves are unchanged —
this doc is a record of what was found, not a tracker.

| Finding | Fix status |
|---|---|
| 1 — two attempts of one run executing concurrently | ✅ Done — process half fe04650 (SIGTERM shape, lock held to exit), database half 57a1f5e + 7296766 (`ctx.tx`'s fence, the one bump path). ✅ **Its gate case, redeploy case 7, is written** (e6bde42): the adversary's own two-worker scenario, with worker A's step abandoned mid-loop by the drain and worker B polling for the lock, asserting that B's lock is younger than A's last committed write. Three deviations, all recorded under chunk 14 in the ordering doc. |
| 2 — `decide()`'s workflow-id formula | ✅ Done — one bump path in `packages/workflows/src/bump.ts`, `N + 1` computed in application code with a compare-and-set (7296766, extracted out of `reconcile()` at b0b6242). Gate: redeploy case 8 (5b25f21) and `fence.test.ts`'s two-bump unit half. Step (2) is deleted in the built `reconcile()`, as disposed. |
| 3 — the budget kill switch disabling itself | ✅ Done — `reserved_usd` never existed as a column; the reservation is derived under the period row's lock (753e923) and `reconcile()` step (4) moves non-live `started` rows to `abandoned` (a359f06). Gate: redeploy case 9 including its three-pass idempotency half (060aaef). |

## Finding 1 — CRITICAL, live-reproduced: the advisory lock does not prevent two attempts of one run from executing concurrently

**Target attacked:** (a) the reconciler — whether `SIGTERM` drain + `cancelWorkflow` + the advisory lock actually fence two attempts of one run from running a non-ledger step at the same time.

**Result: broken, reproduced end to end with a live two-process repro against real Postgres.**

The advisory lock fences *processes*, not *step bodies*. `DBOS.shutdown()`'s drain is documented to abandon workflows that don't finish in time rather than kill them (`dbos.js` JSDoc: "If they do not finish in time, shutdown proceeds without them"); `awaitRunningWorkflows` simply times out and returns. The old worker then releases its advisory lock and exits *while its step body keeps running* — nothing in the plan's design gives that body a way to be interrupted (no `timeoutMS`/`AbortController` is passed; `retriesAllowed: false` means the only cancellation check, `checkIfCanceled` before the body starts, has already passed by the time cancellation happens).

Meanwhile `cancelWorkflow` — called by `reconcile()` on the new worker — is a bare `UPDATE dbos.workflow_status SET status='CANCELLED' ...`. No IPC, no signal, no interruption of the running function on the other process.

Reproduced: worker A's step body kept writing to a shared app row for ~4 seconds *after* worker B's replacement attempt had already started, run to completion, and succeeded. The cancelled attempt's write landed last — DBOS never learned the "cancelled" body kept running, and nothing in the plan's design (not `hf_run`, not `dbos.workflow_status`, not `possible_double_charge`, which only covers the ledger table) makes this visible.

**Severity: silent data corruption on any redeploy that lands mid-flight on a non-ledger step longer than the drain window** — e.g. resolution, scoring, any app-authored step. This directly contradicts the plan's own Risks section, which names exactly these two mechanisms ("the advisory lock, `cancelWorkflow` before the next attempt") as the mitigation — both are proven not to prevent the interleaving.

## Finding 2 — HIGH: `decide()`'s literal SQL computes the wrong workflow id and silently no-ops the approved action

**Target attacked:** (c) `decide()` — the commit-to-enqueue window and whether a queue-name mismatch could leave a run enqueued nowhere.

**Result: the queue-name attack as posed doesn't apply (the plan never defines per-flow queue names precisely enough to construct it) — but a different, more direct bug was found and confirmed live: the id-generation formula itself is broken.**

The plan states two different formulas for the next attempt's workflow id:
- `reconcile()` (line 101): bump the attempt counter, *then* name it — id = `run_id:(attempt+1)`.
- `decide()`'s literal SQL (line 202): `UPDATE hf_run SET attempt = attempt + 1, current_workflow_id = run_id || ':' || attempt` — Postgres evaluates the RHS of a single `UPDATE` against the *pre-update* row, so this actually computes `run_id:attempt` (the *old* attempt number, one behind reconcile's formula).

Confirmed live: two sequential bumps via this exact SQL produced `R:1` then `R:2` — i.e., always one behind what a matching `reconcile()`-style bump would produce.

**Failure path:** a run gets bumped once by `reconcile()` after a deploy (id becomes `R:2`), reaches an approval, and ends. On approval, `decide()`'s formula computes `current_workflow_id = 'R:2'` — the id of the *already-finished* workflow from the reconcile bump, not a new one. `enqueue()` is then called against that id.

DBOS's actual conflict-handling for `DBOSClient.enqueue()` (traced to the real code path, not the SDK line the plan cites — `system_database.js:856`'s `ON CONFLICT DO NOTHING` is the *batch* enqueue path, unreachable from `DBOSClient.enqueue()`; the real path is `:3800`'s `DO UPDATE`) only touches `updated_at`/`executor_id` on a collision with an existing row. Status, inputs, and application_version are never reset. Calling `enqueue()` against an id that already exists as SUCCESS is a **silent no-op — no error, no warning, zero executions.**

Result: the approval is recorded as approved (audited, `resume_workflow_id` set), but the actual post-approval action — the flow logic after `waitForApproval` — never runs, and nothing anywhere reports it. `reconcile()`'s own step (2), meant as the backstop for exactly this kind of crash-window gap, can never catch it either: its selector is `resume_workflow_id IS NULL`, and `decide()` always sets that column *inside* the same transaction that computes the bad id — so step (2)'s predicate never matches, making it dead code as specified. The Phase 1 gate's own assertion of `current_workflow_id = '<run>:2'` would in fact fail against this literal SQL, but only in the simple decide-only path; no gate case runs a `reconcile()` bump *before* the approval, which is the specific ordering that produces the id collision (as opposed to a merely-cosmetic off-by-one).

**Severity: high — defeats Done-means 1 and 7 silently**, with no error surfaced anywhere.

## Finding 3 — HIGH: the budget kill switch permanently disables itself over time

**Target attacked:** (b) the ledger's `started` branch under cross-version restart — whether two concurrent processes could both make an unflagged double provider call.

**Result: the assigned target held** — genuinely, well-grounded against real SDK source (DBOS's recovery scan cannot re-run a cancelled attempt; the `hf_app_state` singleton row lock serializes every ledger insert, closing the TOCTOU gap that was hunted for). This is a real "held" result, not a soft pass — see the disposition table below for what to carry forward as verified.

**But the same investigation surfaced an unrelated, unforced bug in the same table's lifecycle:**

A `started` ledger row left behind when a run *fails* (as opposed to completing) is never transitioned to `ok` or `error` by anything in the protocol — no step in the ledger, no reconciler step, nothing. But `reconcile()`'s step (4) ("release `reserved_usd` for `started` rows whose run is `done`/`failed`") runs **every minute** as a scheduled function, and unconditionally subtracts that row's reserved estimate from `hf_app_state.reserved_usd` — with no record on the row that its reservation was already released, and no floor on the counter.

Result: `reserved_usd` walks unboundedly negative, once per orphaned `started` row, forever. The budget gate (`spent + reserved + estimate > budget`) becomes permanently unsatisfiable once `reserved_usd` is sufficiently negative — **`BudgetExceeded` can never fire again for the life of the app.** This is a silent, monotonic degradation of a stated safety property (Done-means 6, the budget half of the kill switch), not a crash or a race — it happens on the very first run that fails with an orphaned `started` row, and gets worse from there.

**Why the plan's own tests miss it:** the only reservation assertion in the Phase 1/2 gates is on a run that finishes clean with zero orphaned `started` rows (`reserved_usd = 0` at the end of a successful 1,000-record loop) — the defect state (a `started` row on a *failed* run) is never constructed by any named test.

## Disposition: what needs to change

*Status per item added 2026-09-17: 1 ✅ built (the third option was taken — every app-table write is fenced
on `hf_run.current_workflow_id`, plus `process.exit` on the drain's settlement, and no interruption primitive
is relied on), though its gate case is still unwritten; 2 ✅ built (the read-increment-write bump path, one
path for all four callers); 3 ✅ built (the `abandoned` terminal status, idempotent because the predicate is
the status — there is no counter to release).*

1. **The redeploy/concurrency model needs a real interruption mechanism**, not a documentation-level assumption that the advisory lock plus `cancelWorkflow` fence step bodies. Options worth evaluating: `timeoutMS`/`AbortController` wired into every step so a cancelled workflow's body can actually be interrupted; a hard `process.exit()` immediately after the drain deadline with no intervening `await` (closes the DB-write half of the hazard, not an in-flight HTTP call); or redesigning non-ledger steps to be safe under the interleaving directly (e.g., every app-level write also keyed and conditioned on `(run_id, attempt)` so a stale attempt's write can't beat a fresh one) rather than relying on process-level exclusivity at all.
2. **`decide()`'s workflow-id formula must match `reconcile()`'s exactly** — likely fixed by computing the new attempt number in application code (read, increment, write) rather than in a single SQL expression that evaluates against the pre-update row, or by using `RETURNING` correctly. `reconcile()`'s step (2) backstop needs a real predicate that can actually match a genuine gap, once the id bug is fixed and the true commit-to-enqueue crash window is defined precisely.
3. **The ledger needs a real terminal state for `started` rows on failed runs** — something transitions the row (to `error`, or a new `abandoned` status) exactly once, and `reconcile()`'s reservation release must be idempotent per-row (e.g., gated on that transition, or recorded via a boolean/timestamp on the row) rather than an unconditional subtraction that can run every minute forever.

## Held, verified this round (carry forward, don't re-litigate)

- DBOS's own recovery scan cannot re-dispatch a cancelled attempt (status + application_version filter, atomic UPDATE...RETURNING).
- The `hf_app_state` singleton row lock genuinely serializes every `llm.run` ledger insert — no TOCTOU gap for the insert-or-read-back pattern itself.
- No unflagged double provider call is constructible via the cross-version restart path that was attacked — the "at most one extra call, always flagged" property holds for the ledger's *own* flagging mechanism (independent of the separate `reserved_usd` bug above).
- Two concurrent `decide()` calls on different approvals of the same run are correctly serialized by the `FOR UPDATE` lock on `hf_run`.
