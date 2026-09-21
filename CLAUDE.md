# hyperfixation-core

`packages/` holds the nine published packages — `db`, `core`, `ai`, `workflows`, `auth`, `admin`,
`testing`, `cli`, `eslint-config` — versioned as one fixed group; `packages/tools` is private
maintainer tooling and never publishes. The app template is the separate
`grahamlutz/hyperfixation-template` repo: it consumes these from npm, not from this workspace.

## The loop

- One PR per plan chunk. Every code PR body carries a `## Built` section — deviations from the
  plan, findings, timings. Plan-doc updates are batched into one docs PR per track, never one per
  code PR.
- A flake is a bug: file it and fix it, never retry-merge. `packages/ai/src/redeploy-case-1.test.ts`
  and the EPIPE fix in #60 both looked like flakes and were real defects.
- Before merging a PR that changes an exported type, run the template against it:
  `pnpm template:check`.
- Cross-repo order: core merges **and publishes** before the template PR that needs the change.
- Regenerate `etc/*.api.md` from a clean clone — an incremental build reorders union members, so
  the diff you get locally is noise that hides the real API change.
- Wait for CI: `gh pr checks <n> --watch && gh pr merge <n>`, or `gh pr merge --auto`. A hook
  blocks merging through red.
- A security-sensitive PR is never self-merged by the agent that wrote it: open it, get CI green, then an
  adversary review and an orchestrator merge.
- Never loosen `api-diff` to make a PR pass — shape the change so the gate sees an addition. #124 moved a
  column to its own table rather than widen the gate; #131 tracks the blind spot.
- Never `docker system prune` or `docker image prune -a` — the colima disk is small.
- Never `npm publish` by hand: merging the `Version Packages` PR runs `release.yml`, which publishes all nine
  with OIDC trusted publishing and tags the release.
- A deploy is a command, not a merge. Coolify's push auto-deploy is off on every app `hf new` creates, so a
  merged bump reaches the box only through `hf deploy <name>`.
- Before adding a repo to `downstream.txt`, check its own CI is green. That file is the only list: both
  `ci.yml`'s `downstream` matrix and `release.yml`'s `bump` matrix are built from it, one job and one
  repo-scoped App token each.
- Pin every third-party action by commit SHA with a `# vX.Y.Z` comment — `workflow-pins.test.ts` fails a tag.
- Mail goes through the template's one shared sender; nothing else sends.
- A secret must never reach an error message or a log — an `SMTP_URL` token did, in X1 — and API tokens are
  IP-restricted.
- Remove a worktree and delete its branch as soon as its PR merges.

## Versioning

[planning/hyperfixation-versioning-policy.md](planning/hyperfixation-versioning-policy.md). CI
fails any PR that changes a published package's `src` or a committed `etc/*.api.md` without a
changeset.
