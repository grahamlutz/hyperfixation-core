# @hyperfixation/db

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

## 0.1.9

### Patch Changes

- 5662f8d: Promote a session only on a passkey **that session** enrolled, and let a code session near nothing
  else in the passkey plugin. `upgradeSessionFactor` updated on `token = $1 AND factor = 'code'`
  alone, and the WebAuthn ceremony is client-side — so anyone who could read an admin's inbox could
  sign in with the emailed code, call the template's `promoteSession()` action without ever touching
  an authenticator, and hold `factor = 'passkey'` and with it the whole of `/admin/*`.
  
  Two things had to be shut, and the first attempt at each was wrong:
  
  - **Every authenticated `/passkey/*` endpoint, not just the two registration ones.** The plugin
    also exposes `list-user-passkeys`, `delete-passkey` and `update-passkey`, each guarded on a
    session and — on two of them — resource ownership, never a factor. A code session could list the
    victim's passkey ids, delete them, and so become a "first enrolment" again, at which point
    enrolling its own authenticator and promoting was honest. The gate is now an inversion:
    `isGuardedPasskeyPath` covers every `/passkey/*` path but the two unauthenticated sign-in ones,
    so an endpoint a plugin upgrade adds is refused by default. A code session may reach
    `generate-register-options` and `verify-registration`, and only while its user holds **zero**
    passkeys; everything else answers 404, the policy's refusal for something that must not describe
    itself. A passkey session may drive all of them.
  - **The promotion has to be bound to a session, not to a clock.** `EXISTS (… p.created_at >=
    hf_session.created_at)` was a time comparison: an attacker's idle code session promoted itself
    the moment the victim legitimately added a second device from their own passkey session. The
    proof is now a row in the new `hf_session_passkey_enrolment` table, written by a `hooks.after` on
    `/passkey/verify-registration` for the *calling* session and only when the plugin returned a
    verified registration — better-auth runs after-hooks over a thrown `APIError` too. `session_id`
    is the whole key and cascades from `hf_session`, so a second registration from one session is
    inert and the proof cannot outlive the session. The statement is `… WHERE token = $1 AND factor =
    'code' AND expires_at > now() AND EXISTS (SELECT 1 FROM hf_session_passkey_enrolment e WHERE
    e.session_id = hf_session.id) AND EXISTS (SELECT 1 FROM hf_passkey p WHERE p.user_id =
    hf_session.user_id)`, one UPDATE so two concurrent calls still move one row.
  
  `resetSecondFactor` remains the only code-path recovery and still reopens enrolment, because it
  deletes the passkeys and every session with them.
  
  New exports: `mayEnrolPasskey`, `isGuardedPasskeyPath`, `PASSKEY_REGISTRATION_OPTIONS_PATH`,
  `PASSKEY_REGISTRATION_PATHS`, `PASSKEY_AUTHENTICATION_OPTIONS_PATH`, `PASSKEY_SIGN_IN_PATHS` —
  every one of them additive.
  
  **Patch on both counts the policy names.** Core migration `0010_session_passkey_enrolment`
  creates one table and alters nothing, so it is additive against N-1's readers and
  `migration-additivity.test.ts` passes. The reports change only additively as well: the new table is
  an added export, `hfSession`'s printed type is untouched, and `GRANT_RO_EXCLUDED_TABLES` — which
  the table joins, because a row of it names a session — is a const tuple that only grew, which the
  gate already excuses. A column on `hf_session` would not have been additive to `api-diff`: it
  reprints `hfSession.columns` and, through `AUTH_SCHEMA`, `AUTH_SCHEMA.session`, and both read as
  *retyped* members with no route through the gate. Issue #131 tracks that blind spot; the gate
  itself is unchanged by this release.
  
  An existing code session in a live database has no enrolment row and simply cannot promote until a
  fresh enrolment, which is the intended reading and needs no backfill. A session minted by passkey
  sign-in already holds `factor = 'passkey'` and never consults the table.

## 0.1.8

### Patch Changes

- 7715754: Bill a period at the ledger's own scale. `hf_budget_period.spent_usd` was `numeric(12,4)` while
  `hf_llm_call.cost_usd` is `numeric(12,6)`, and every settle is `spent_usd = spent_usd + cost_usd`,
  so each sub-cent call rounded the running total and the error grew with the number of calls — the
  first two real provider calls on the X1 box reported a `$0.000007` drift and a `degraded` status.
  Migration `0009_budget_spent_scale` widens the column to `numeric(12,6)` and repairs the rounding
  already stored. `/api/status` and `reconcile()` now subtract in Postgres at that scale, so
  `spentUsd`, `ledgerUsd` and `driftUsd` all print six decimals and a settled period drifts by
  exactly `0.000000`.

## 0.1.7

### Patch Changes

- ecd68f2: `TestDatabase.drop()` now waits for the database's own backends to disconnect before the
  `DROP DATABASE … WITH (FORCE)`, instead of terminating whatever it finds. Awaiting every
  `pool.end()` in an `afterAll` was never that guarantee: `pg`'s `pool.end()` resolves as soon as
  it has *called* `client.end()` on each pooled connection, not when their sockets have closed, so
  the drop raced connections that were still winding down. A client killed mid-`end()` still
  carries `pg-pool`'s `idleListener`, which re-emits the `57P01` on a pool nothing is listening to
  — an uncaught exception that failed a task after all of its tests had passed. The wait is
  bounded, so a genuinely leaked connection is still forced out rather than hanging the teardown.
- 06695ea: The core migrations now have a mechanical additivity check. `migration-additivity.test.ts` reads
  every committed migration and fails on a `DROP TABLE`, `DROP COLUMN`, `RENAME`,
  `ALTER COLUMN … TYPE`, `SET NOT NULL` on a column the migration did not add, or a
  `DROP CONSTRAINT`/`DROP INDEX` on an object an earlier migration created — the statements that
  break a release for version N-1's readers, which run against the new schema between `migrate` and
  the new `web`/`worker`. `migration-additivity.allow.json` is the only way past it: one
  `{ file, reason, replacedIn }` per migration, naming the release that already shipped the
  replacement. Nothing a consumer imports changed.

## 0.1.6

No changes in this release.

## 0.1.5

No changes in this release.

## 0.1.4

No changes in this release.

## 0.1.3

No changes in this release.

## 0.1.2

No changes in this release.

## 0.1.1

### Patch Changes

- `/api/status` now carries `llm.mode`, which `reportProvidersMode(pool)` writes at worker boot
  (migration 0008), and `hf doctor` warns when an app is serving fixture drafts. The CLI gained the
  cloud `hf new` path, `hf doctor` and `hf restore-check`, with the SSH runner and provisioning
  behind them; a child that exits before reading its stdin no longer fails a run with `EPIPE`, and
  `hf_score` names the spec it scored.

## 0.1.0

### Minor Changes

- First published version. The nine packages move as one fixed group, so this entry bumps all of
  them; the template consumes them from npm instead of a sibling checkout from here on.
