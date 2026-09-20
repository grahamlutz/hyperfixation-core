---
"@hyperfixation/db": patch
---

The core migrations now have a mechanical additivity check. `migration-additivity.test.ts` reads
every committed migration and fails on a `DROP TABLE`, `DROP COLUMN`, `RENAME`,
`ALTER COLUMN … TYPE`, `SET NOT NULL` on a column the migration did not add, or a
`DROP CONSTRAINT`/`DROP INDEX` on an object an earlier migration created — the statements that
break a release for version N-1's readers, which run against the new schema between `migrate` and
the new `web`/`worker`. `migration-additivity.allow.json` is the only way past it: one
`{ file, reason, replacedIn }` per migration, naming the release that already shipped the
replacement. Nothing a consumer imports changed.
