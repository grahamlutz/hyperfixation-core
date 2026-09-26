---
"@hyperfixation/db": patch
"@hyperfixation/core": patch
---

A raw-fetch cache with per-host rate limits, so a collector reads its source over HTTP without
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

New exports, every one additive: `fetch`, `fetchGet`, `fetchDomainOf`, `urlHash`,
`FetchTooLarge`, `RawFetch`, `FetchGetOptions`, the five `FETCH_*` statements, the three
`*_FETCH_*` defaults, and the `hfRawFetch`/`hfFetchDomain` tables. Nothing existing is retyped,
which is what keeps this a patch and what `api:diff` confirms.
