---
"@hyperfixation/testing": patch
"@hyperfixation/db": patch
---

`TestDatabase.drop()` now waits for the database's own backends to disconnect before the
`DROP DATABASE … WITH (FORCE)`, instead of terminating whatever it finds. Awaiting every
`pool.end()` in an `afterAll` was never that guarantee: `pg`'s `pool.end()` resolves as soon as
it has *called* `client.end()` on each pooled connection, not when their sockets have closed, so
the drop raced connections that were still winding down. A client killed mid-`end()` still
carries `pg-pool`'s `idleListener`, which re-emits the `57P01` on a pool nothing is listening to
— an uncaught exception that failed a task after all of its tests had passed. The wait is
bounded, so a genuinely leaked connection is still forced out rather than hanging the teardown.
