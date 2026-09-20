# Hyperfixation maintainer tooling and delivery process — "the script strategy"

**Date:** 2026-09-19. Planner output, saved verbatim in substance. **Written against** core `origin/main` `94d2cc3` and template
`origin/main` `65df6e4`. Every "exists / does not exist" claim was checked against those refs or with `gh`; anything not checked is
marked *unverified*.

**Concern up front:** the biggest structural fix — a core CI job that runs the template against the PR's packed tarballs — is a
mechanism nothing in either repo has yet; the tarball-override install is rehearsed in template #33's body but never in CI. Run the
`adversary` agent against topics 3 and 4's claims before starting.

## Status — built 2026-09-19

| Item | State |
|---|---|
| `guard.py` blocks `gh pr merge` on failing/pending checks (agents repo; uncommitted in the working tree with the user's own `_migration_committed` change) | done; `--auto` and `gh pr checks N --watch && gh pr merge N` pass, `--admin` is always blocked, it fails open. A first version matched prose that merely mentioned the commands (a heredoc'd doc, a PR body) and blocked its own fix; it now inspects only a skeleton of the command with heredoc bodies and quoted strings blanked, with regression tests |
| Template branch protection | ruleset `main` (id 23716791): required `check`, `image`, `compose`, no up-to-date rule, no deletion or non-fast-forward; `allow_auto_merge` on |
| Core ruleset | ruleset `main` (id 23717389): required `test`, `downstream`, `changeset`, no up-to-date rule; the classic branch protection is deleted |
| **Merge queue** | **not available**: the ruleset API rejects `merge_queue` (`Invalid rule 'merge_queue'`) because GitHub offers merge queues only on organization-owned repos and `grahamlutz/*` is a personal account. Fallback applied: required checks without "up to date"; `gh pr merge --auto` is the norm. Trade: two PRs that each pass alone can conflict once both are on `main`; the `push: main` run catches it. Moving both repos into a (free) GitHub org would unlock a real queue — revisit only if the serial cost returns |
| `packages/tools` scaffold, `template:check`, `merge_group` and the `downstream` job (core #66) | `downstream` runs the template's typecheck and 15-file suite against the PR's packed tarballs (1m54s to 2m19s); demonstrated to fail on a renamed `BoardView` member |
| Core `CLAUDE.md`, `planning/hyperfixation-versioning-policy.md`, the changeset CI job (core #67) | the check flags only `packages/*/src` (minus tests) and `etc/*.api.md`, skips private and ignored packages and version PRs, and requires a changeset **added** on the branch; a separate `changeset` job, hence the third required check |
| `release:publish`, `release:rehearse`, `release:verify` (core #69) | rehearsal against a real Verdaccio in 17.4 s; refuses without a TTY; per-version registry documents, never `npm view`; skips already-published packages; never stores a token |
| `dev:doctor`, `dev:clean`, `worktrees:clean` (core #70) | dry-run by default; never `image prune -a`, `system prune` or `--volumes` |
| `plan:sync`, the `Chunk:` and `## Built` convention, the PR template (core #68) | a generated status table in the Phase 3 doc from 98 merged PRs; the template repo still needs its own PR template |
| Versioning policy | written (see the policy doc) |
| OIDC `release.yml` | Phase 4: configure trusted publishers on npmjs.com (nine, user-performed), then `changesets/action` with `id-token: write` |
| Local dev infra fixes | user-performed: recreate `hyperfixation-pg` with `--restart unless-stopped` and a named volume; `colima start --disk 60` (interrupts other projects' containers); `worktrees:clean --yes` and `dev:clean --yes` when chosen |

**Corrections to this plan found while building it.** Role names: a leaked `hf_test_x`'s application role is `hf_test_x` itself
(`roles.ts:37-43` gives `hf_<app>_migrator`, `hf_<app>`, `hf_<app>_ro`), not `test_%_{...}`. buildx 0.37 renamed `--keep-storage` to
`--reserved-space`. `pnpm pack`, unlike `publish`, does not skip private packages, so `template:check` filters them. Merged worktrees look
unmerged (squash merges), so `worktrees:clean` keys off the PR's `headRefOid`. **A test hazard, fixed:** the first `worktrees.test.ts` set its
fixture's `origin` to the real repo and pushed four throwaway branches to GitHub (`merged-clean`, `merged-dirty`, `merged-unpushed`,
`unmerged`); they were deleted and the fixture can no longer reach a remote. **New working rules from this:** every code PR that changes
`packages/*/src` or `etc/*.api.md` needs a `.changeset/*.md`; merge with `--auto`, or `gh pr checks N --watch && gh pr merge N`.

## Goal and problem

A session is spent on serial merge cycles, a merge went through red, an unrelated repo went red after a core merge, publishing is a
manual browser dance, and every PR trails a docs PR. Core has one required check (`test`) with `strict: true` and no downstream job;
the template has **no branch protection at all** (`gh api .../branches/main/protection` → 404), which is how template #11 merged with
`check: FAILURE`; and nothing in either repo is a place for maintainer tooling to live.

## 1. Script strategy

**Decision:** maintainer tooling lives in a **private workspace package `packages/tools`** (`"private": true`, never published —
`pnpm -r publish` skips it), not a root `scripts/` directory. Root `pnpm test` is `turbo run test` (`package.json:14`), and turbo runs
only package tasks, so root-level tests would never run in CI. As a workspace package it inherits `typecheck/lint/test` and CI coverage
for free. Add it to `.changeset/config.json` `ignore` (the fixed group lists names explicitly at lines 6–16, so it will not be
versioned) and give it no `api-extractor.json`. Entry points are pnpm scripts at the root
(`"release:publish": "pnpm --filter @hyperfixation/tools run publish"`), TypeScript via `tsx`, vitest for anything with branching logic.
Bash only where the script is `exec`-thin. `HF_TEMPLATE_DIR` defaults to `../hyperfixation-template`. Product commands stay in
`packages/cli` (`COMMANDS`, `cli.ts:15–26`) — nothing here ships to users. Template app-level scripts already live in the template's
`package.json`.

| Script | Inputs | Safety | Tested |
|---|---|---|---|
| `release:publish` | `--version`, `--registry`, `--dry-run` | fresh clone, no secrets on disk, explicit confirm, idempotent retry | unit: guard logic against a fake registry client; integration: Verdaccio |
| `release:rehearse` | same | Verdaccio on `:4873` in a temp dir; never touches npmjs | the integration above |
| `template:check` | `HF_TEMPLATE_DIR`, `--registry` (optional) | read-only on core; installs into the template checkout with `pnpm.overrides` → packed tarballs; restores lockfile | unit for the override rewrite; runs in CI (topic 3) |
| `worktrees:clean` | `--dry-run` (default), `--yes` | lists only; deletes only branches `gh pr list --state merged --head` confirms | unit on a fixture repo |
| `dev:doctor` / `dev:clean` | none / `--yes` | doctor never mutates; clean never drops a database with an active backend | unit on the SQL filter; manual |

`ci-status` is rejected: `gh pr checks --watch` already does it. **Rejected:** root `scripts/*.ts` with tsx (untested by CI as shown
above) and a Bash-first layout (the publish guards are logic, not plumbing).

## 2. Publish script

`packages/tools/src/publish.ts`, run as `pnpm release:publish 0.1.2`, in order:

1. `git clone --depth 1 --branch main` of `origin` into a temp dir (never the working tree).
2. Assert every package in the fixed group has `version === <arg>` and no `workspace:` ranges survive `pnpm -r pack` (core #64 checked this by hand).
3. `npm whoami` must succeed; `npm profile get --json` must report `tfa.mode` as `auth-and-writes`, else stop with the 403 explanation.
4. `pnpm install --frozen-lockfile && pnpm -r build && pnpm -r publish --access public --dry-run --no-git-checks`; print the nine tarball names and sizes; wait for a typed `yes`.
5. Real publish, one package at a time in topological order; before each, `GET https://registry.npmjs.org/@hyperfixation%2f<name>/<version>` — if 200, skip it (the retry semantics for a partial publish: re-run the same command, nothing is `unpublish`ed). The browser-approval handoff is inherited from npm: the script prints the URL and blocks on stdin, so it must run in a visible terminal and refuses to start when `!process.stdout.isTTY`.
6. Verify: every version URL is 200 and `dist.integrity` matches the local tarball's — the per-version document, not `npm view` (the full packument 404s from cache).
7. Print the `core-bump` dispatch command (`gh api repos/grahamlutz/hyperfixation-template/dispatches -f event_type=hyperfixation-core-release -f client_payload[version]=<v>`), which `core-bump.yml` already listens for; do not run it.

Never stores a token; never writes `.npmrc`.

**Bridge to Phase 4 (OIDC).** Per package on npmjs.com (user-performed, nine times): Package settings → Publishing access → Trusted
publisher → GitHub Actions, repository `grahamlutz/hyperfixation-core`, workflow `release.yml`, environment blank. Then `release.yml`:
`on: push: branches: [main]`, `permissions: { contents: write, pull-requests: write, id-token: write }`, `changesets/action@v1` with
`publish: pnpm -r publish --access public --provenance --no-git-checks` and `version: pnpm changeset version`, no `NPM_TOKEN`. Cut over
when `release:rehearse` is green against Verdaccio **and** one real publish (0.1.2) has gone through the script. After cutover the script
keeps steps 2, 6 and 7 as `release:verify <version>` and drops the rest. Deadline: before early August 2026 the 2FA-bypass token route
degrades; there is no reason to ever create one. **Open (user):** cut over at 0.1.2 or 0.2.0? Recommendation: 0.1.2.

## 3. Merge queue

Relaxing "up to date" (`strict: false`) is a one-call fix but trades the serial-CI cost for silent semantic conflicts on `main`.
Auto-merge alone does not remove the update-branch requirement. A GitHub merge queue removes the requirement (the queue builds the
merge commit and tests it), batches, and is available on both repos because both are public. Cost: one queue CI run per merge (~7 min
core) *instead of* N re-runs across open PRs — a net win at N ≥ 2.

**Decision:** merge queue on core now; branch protection on the template today (it has none), queue on the template once the `image`
job (10 min) is either cached or split — until then the queue would serialize at 10 min per merge.

**Workflow changes (agent-implemented core PR, `.github/workflows/ci.yml:3–5`):** add `merge_group:` to `on:`; keep the job name `test`
so the required-check name is unchanged. Add a second required job `downstream`: check out the template at `main`, `pnpm -r pack` core,
run `template:check` (typecheck + `pnpm test`, ~3 min). This is the deterministic answer to core #46 turning template main red. Template
`ci.yml:3–5` gets `merge_group:` too.

**Settings (user-performed):**

```
# core: replace classic protection with a ruleset carrying the queue
gh api -X POST repos/grahamlutz/hyperfixation-core/rulesets --input - <<'EOF'
{"name":"main","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["refs/heads/main"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"},
  {"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,
    "required_status_checks":[{"context":"test"},{"context":"downstream"}]}},
  {"type":"merge_queue","parameters":{"merge_method":"SQUASH","max_entries_to_build":5,
    "min_entries_to_merge":1,"max_entries_to_merge":5,"min_entries_to_merge_wait_minutes":2,
    "grouping_strategy":"ALLGREEN","check_response_timeout_minutes":30}}]}
EOF
gh api -X DELETE repos/grahamlutz/hyperfixation-core/branches/main/protection
# template: protection first, queue later
gh api -X POST repos/grahamlutz/hyperfixation-template/rulesets --input - <<'EOF'
{"name":"main","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["refs/heads/main"],"exclude":[]}},
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"},
  {"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,
    "required_status_checks":[{"context":"check"},{"context":"image"},{"context":"compose"}]}}]}
EOF
gh api -X PATCH repos/grahamlutz/hyperfixation-template -f allow_auto_merge=true
```

Order: the workflow PR with `merge_group` merges **before** the ruleset is created, or the queue waits on a check that never reports.
The `merge_queue` rule parameter names are from GitHub's ruleset schema (*unverified* against this account's API version — `GET
/repos/.../rulesets` after creation and compare). **Agents:** `gh pr merge --squash --auto` enqueues; the queue gates; agents never wait
on CI themselves. **Rollback:** `gh api -X DELETE repos/.../rulesets/<id>`; the `merge_group` trigger is harmless without a queue.

## 4. Codify the loop

One rule each, placed where it can be enforced — anything a hook or CI can hold does not go in prose:

| Rule | Where | Why there |
|---|---|---|
| Never merge through red/pending | **`guard.py` PreToolUse** (global, any repo) | it is the rule that was broken |
| Template must pass against a core PR | **core CI `downstream` job** (topic 3) | CI, not memory |
| Stage explicit paths; no attribution | already in `guard.py` (`BASH_BLOCKS`) | done |
| Cross-repo order: core merges and publishes before the template PR that needs it | core `CLAUDE.md` | judgment; the template PR is red until then anyway |
| A flake is a bug: file it, fix it, never retry-merge | core `CLAUDE.md` | judgment |
| One PR per chunk; docs batched per track (topic 6) | core `CLAUDE.md` | convention |
| Worktree hygiene | `worktrees:clean` script + one line in `CLAUDE.md` | tool |

**The hook.** In `guard.py`, one new `BASH_BLOCKS` entry: pattern `\bgh\s+pr\s+merge\b`; condition: allow when `--auto` is present
(GitHub gates); otherwise resolve `-R/--repo` and the PR argument, run `gh pr checks <pr> [-R repo] --json state` with a 10 s timeout,
and block when any `state` is not `SUCCESS`/`SKIPPED`/`NEUTRAL`. Fail-open on timeout/error like the rest of the file. Tests in
`tests/guard-tests.sh` via a `CLAUDE_GUARD_PR_CHECKS` env override returning canned JSON. Core `CLAUDE.md` does not exist on
`origin/main`; create it at ~15 lines: the loop, the four judgment rules above, `pnpm dev:doctor` first.

## 5. Versioning policy

Fixed group at 0.x. **Breaking at 0.x** = any diff to a committed `etc/*.api.md` that removes or retypes a member, any `hf_*` schema
change version N-1 cannot run against, any change to key derivation for `llm.run`/`actions.perform`/`waitForApproval` (plan line 303).
**Changesets:** `patch` = api.md unchanged or purely additive; `minor` = breaking as defined. A CI step `pnpm changeset status
--since=origin/main` fails a PR that touches `etc/*.api.md` without a changeset. **1.0** when Phase 5's second app is live and the Phase 4
`api-diff.test.ts` + `deprecations.json` gate exists — not before. **Deprecations:** an export leaves in two releases: marked in
`deprecations.json` with the removing version in release N, removed in N+1's minor. **Migrations:** a core migration must be additive
against N-1's readers (no drop/rename of a column N-1 reads; two-release rule), because `docker-compose.prod.yml` runs `migrate` before
the new `web`/`worker`. **Template pin:** `^0.1.1` means a breaking `0.2.0` is never auto-picked; only `core-bump.yml`'s `pnpm update
--latest` moves it, and the app's contract suite gates. `minimumReleaseAgeExclude` stays.

## 6. Plan-doc updates

Fourteen of the last 25 core commits are docs syncs. **Decision:** kill the per-PR docs PR. Every code PR body has a `## Built` section
(deviations, findings, timings — what today goes into the `> **Built (core #N)**` blockquotes). A `packages/tools` script `plan:sync`
reads merged PRs via `gh pr list --state merged --json number,title,body,mergedAt` and rewrites the status table at the top of the current
phase-order doc from a `Chunk: D3` line in the body; hand-written prose in the order doc is reserved for deviations from the plan and
decisions. Docs PRs become one per track. Rejected: a bot that appends bodies to the doc (appended bodies rot); a fully generated
`docs/status.md` (the deviation notes are the valuable part and cannot be generated).

## 7. Local dev infra

Verified: colima disk 30 GB, 18 GB used, of which build cache 8.9 GB across 52 entries with 0 active; `hyperfixation-pg` is a bare
`docker run` with restart policy `no` and an **anonymous** volume; the cluster holds 12 leaked `hf_test_*` databases plus
`hf_prod_295bc713`, `c64e2e`, `c64app_dev`; `docker buildx v0.37.1` is present; 55 core worktrees and 22 template worktrees exist, and
because PRs are squash-merged, `git merge-base --is-ancestor` reports almost none as merged — cleanup must ask `gh`.

- **Disk:** `colima stop && colima start --disk 60` (user-performed; growing in place *unverified* for this version; back up the volume first). `dev:clean` prunes `docker builder prune --keep-storage 4GB` and dangling images only; never `docker image prune -a`, never `--volumes`.
- **Postgres:** recreate once as `docker run -d --name hyperfixation-pg --restart unless-stopped -v hyperfixation-pg-data:/var/lib/postgresql/data -p 5434:5432 pgvector/pgvector:pg17`; `dev:doctor` checks `pg_isready` on 5434, the restart policy, the named volume, free disk on `/var/lib/docker` (< 5 GB free is a warning), buildx, and that colima is running.
- **Isolation:** every test already gets its own database and roles (`packages/testing/src/database.ts:39–86`); contention is only on the shared cluster's connection slots and disk. Leaks come from `drop()` living in `afterAll` — a killed process skips it. `dev:clean` drops `hf_test_%` databases with no backend in `pg_stat_activity`, and their `test_%_{migrator,application,readonly}` roles.
- **Scratch apps:** ports 3010–3019 were used by agents; convention `HF_SCRATCH_PORT` is `3010 + (agent slot)`, scratch databases are named `scratch_<name>`; `dev:clean --yes` drops `scratch_%` too.
- **Worktrees:** `worktrees:clean` runs in both repos, removes worktrees whose branch has a merged PR, then `git worktree prune` and `git branch -D`; sibling dirs `hf-template-*`/`hf-core-*` are worktrees of the same repos, so one script covers both layouts.

## Dependencies and scope

1 before 2, 3's `downstream` job, 6, 7 (they are tools). 3's workflow PR before the ruleset. 4's hook is independent. 2's OIDC cutover
after one scripted publish. 5 is policy plus one CI step. **Scope fence:** no Phase 4 `api-diff.test.ts`, mixin snapshot or
`core-version.test.ts`; no change to `core-bump.yml`; no template merge queue yet; no `hf` CLI changes.

**Done means:** an agent can `gh pr merge --auto` a core PR and the queue merges it only after the template has passed against it; a
release is one command plus browser approvals; the per-PR docs PR is gone.

## PR/agent breakdown (value/effort)

1. **guard.py merge check** — agents repo, 1 file + tests, ~40 lines. Do first.
2. **Template branch protection** — user, two `gh api` calls.
3. **core `merge_group` + `downstream` job** and the `packages/tools` scaffold with `template:check` — one core PR.
4. **Core ruleset with queue** — user, after 3 merges.
5. **`release:publish` + `release:rehearse`** — one core PR; use it for 0.1.1.
6. **`dev:doctor`, `dev:clean`, `worktrees:clean`, core `CLAUDE.md`** — one core PR.
7. **`plan:sync` + the `## Built` convention** — one core PR, plus one docs PR converting the phase 3 doc's status table.
8. **Changeset CI step + policy text in `CLAUDE.md`** — small core PR.
9. **`release.yml` OIDC** — after 5 has run once; user configures nine trusted publishers.

**Do first:** 1, 2, then 3+4 (end the serial-merge cost and close the cross-repo red-main hole), then 5.

## Risks and open questions

- Ruleset `merge_queue` parameter names *unverified*; check with a `GET` after creation.
- `colima start --disk 60` growing in place *unverified*; back up the `hyperfixation-pg-data` volume first.
- `downstream` needs the template checkout in core CI: a public repo, so `actions/checkout` with `repository:` needs no token — but the template's `--frozen-lockfile` install must be bypassed for overrides (`--no-frozen-lockfile` in that job only).
- **User:** OIDC cutover at 0.1.2 (recommended) or later? Template queue now (serial 10-min `image`) or after caching? Recommended: after.
- **User:** keep `strict` semantics anywhere? Recommended: no — the queue replaces it.
