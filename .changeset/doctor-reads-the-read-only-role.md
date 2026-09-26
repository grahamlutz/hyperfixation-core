---
"@hyperfixation/cli": patch
---

`hf doctor` gains a `readonly` line per app: the `_ro` role Metabase reads through exists, can read
`hf_run`, can read none of `GRANT_RO_EXCLUDED_TABLES`, and was created with `CONNECTION LIMIT 4`.
The role was provisioned and its grants applied since Phase 5, but nothing read them back — a
`GRANT` that reached an auth table would have been invisible until someone queried the box by hand.

An absent role WARNs rather than FAILs: Metabase is optional per deployment, and `hf new` creates
the role only when a read-only password was supplied. Everything else FAILs, a readable `hf_user`
above all — that is a reader with a route towards a staff session.

The query runs over the same admin tunnel as the E006, `connections` and `lock` lines, and reads
`has_table_privilege` by oid against `pg_class`, so a table the database does not have reads
`absent` (its own message) instead of erroring the whole line. `readonlyGrantsSql` is exported for
the test that runs it against a migrated database; nothing here is in the package's public API
report.
