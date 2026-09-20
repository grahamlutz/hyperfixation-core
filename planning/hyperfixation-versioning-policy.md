# Versioning policy

**Date:** 2026-09-19. Topic 5 of [hyperfixation-tooling-plan-2026-09-19.md](hyperfixation-tooling-plan-2026-09-19.md),
stated as policy. Applies to the nine published packages, which move as one fixed group in
`.changeset/config.json`.

## What breaks at 0.x

Semver's "0.x may break anything" is not the rule here. A change is **breaking** when it is any
of:

- a diff to a committed `etc/*.api.md` that **removes or retypes** a member (adding one is not);
- an `hf_*` schema change that version N-1 of the packages cannot run against;
- any change to key derivation for `llm.run`, `actions.perform` or `waitForApproval` — the keys
  are the fence, and rederiving them turns a resumed run into a double-send.

Everything else is non-breaking.

## Patch vs minor

- **patch** — `etc/*.api.md` unchanged, or changed only additively; no breaking item above.
- **minor** — any breaking item above. At 0.x the minor is the breaking release, so the
  template's `^0.1.1` will not pick it up on its own.

There is no major bump before 1.0.

## 1.0

Not before both: Phase 5's second app is live on the published packages, and the Phase 4
`api-diff.test.ts` + `deprecations.json` gate exists. Time in service and a mechanical gate
against accidental removals — neither alone is enough.

## Deprecation: two releases

An export leaves over two releases. In release N it is marked in `deprecations.json` with the
version that will remove it; in release N+1's minor it is removed. A removal that never appeared
in a `deprecations.json` is a bug in the release, not a fast path.

A value inside an exported const's literal set leaves the same way. `@hyperfixation/cli`'s
`COMMANDS` is printed as a readonly tuple of string literals, and dropping `"deploy"` from it
breaks every caller of `hf deploy` exactly like a removed export, so `api-diff` reports it and the
tuple may only grow. A tuple member has nowhere to carry an `@deprecated` tag, so for it the
`deprecations.json` entry **is** the announcement: name the symbol `COMMANDS.<name>` —
`{"package": "@hyperfixation/cli", "symbol": "COMMANDS.deploy", ...}` — and the baseline-tag gate
does not apply. The `USAGE` text beside it is prose that every added command reprints; the gate
ignores its contents and relies on `COMMANDS` to catch what actually left.

## Migrations: additive against N-1

A core migration must be additive against N-1's readers — no dropping or renaming a column N-1
reads. `docker-compose.prod.yml` runs `migrate` before the new `web`/`worker`, so between those
two steps the old code is live against the new schema. Splitting a rename across two releases
(add, backfill, then drop in N+1) is the same two-release rule as deprecations.

`packages/db/src/migration-additivity.test.ts` enforces it mechanically. It reads every committed
core migration and fails on a `DROP TABLE`, `DROP COLUMN`, `RENAME`, `ALTER COLUMN … TYPE`,
`SET NOT NULL` on a column the migration did not itself add, or a `DROP CONSTRAINT`/`DROP INDEX`
on an object an earlier migration created — outside comments and string literals. The escape is
`packages/db/src/migration-additivity.allow.json`: one `{ file, reason, replacedIn }` per exempted
migration, where `replacedIn` is the release that already shipped the replacement. An entry is a
reviewer's decision that the two-release rule was followed, not a way around it, and the test
fails an entry whose file no longer violates anything — a stale exemption has to be deleted.

## The template's pin

The template pins `^0.1.1`. At 0.x that caret does not cross a minor, so a breaking `0.2.0` is
never picked up automatically; only `core-bump.yml`'s `pnpm update --latest` moves it, and the
app's contract suite gates that PR. `minimumReleaseAgeExclude` stays as it is: the bump PR is
supposed to see a version minutes after it publishes, which is exactly what the release-age
delay would block.

## Enforcement

`.github/scripts/changeset-check.mjs` (the `changeset` CI job) fails a PR that changes a
published package's `src` or a committed `etc/*.api.md` without adding a changeset. It does not
judge patch vs minor — that is this document's job, and the reviewer's.
