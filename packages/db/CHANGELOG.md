# @hyperfixation/db

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
