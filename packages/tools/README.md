# @hyperfixation/tools

Private maintainer scripts. Nothing here ships to users; product commands belong in
`packages/cli`. Run them from the repo root.

## Releasing

```sh
pnpm release:rehearse 0.1.1     # the whole path against a throwaway Verdaccio
pnpm release:publish  0.1.2     # the manual one, in a visible terminal
pnpm release:verify   0.1.2     # what was published is what main says
pnpm release:ci                 # what .github/workflows/release.yml runs; not for a laptop
```

`release:publish` publishes the fixed group from a **fresh clone of origin/main** — never this
working tree. It asserts every package is at the given version, that no `workspace:` range
survives `pnpm pack`, and that npm 2FA covers writes (`auth-and-writes`; anything weaker gets a
403 on publish). Then a dry run, a typed `yes`, and one package at a time in dependency order,
skipping any whose per-version registry document is already `200` — so re-running it is the retry
for a partial publish, and nothing is ever unpublished. It stores no token and writes no
`.npmrc`: the credential is npm's own browser approval, which is why it refuses to start when
stdout is not a TTY. It prints, but never runs, the `core-bump` dispatch command for the template.

`release:rehearse` runs that same path against Verdaccio on `127.0.0.1:4873` (an ephemeral port if
that one is taken), then installs the published packages into a scratch project and into a copy of
the template checkout (`HF_TEMPLATE_DIR`) and typechecks both. It refuses to publish to anything
that is not loopback, and removes its temp directories even on failure.

`release:verify` compares the registry's `dist.integrity` against tarballs packed from the release
commit — its tag, else the commit that bumped the manifests on `origin/main` — in a throwaway
`git worktree`, never from whatever this checkout has out. The 0.1.1 verification reported a false
integrity mismatch for the CLI because it packed a feature branch. A `404` on a version document is
retried with backoff for three minutes before it counts as missing: after a publish npmjs answers
`npm view` at once but 404s the per-version document for about a minute.

## Running a probe under CPU load

```sh
pnpm load:run 24 120 -- pnpm --filter @hyperfixation/workflows exec vitest run src/some-race.test.ts
```

Spins one core per worker while the command runs. The workers stop when the command exits, when
`load:run` is signalled, after the seconds given, and when `load:run` dies — even by SIGKILL,
because they watch their parent's IPC channel. Don't hand-roll this as
`(while :; do :; done) &` with `kill $(jobs -p)`: zsh's `jobs` is empty inside a command
substitution, so nothing is killed, and 24 such loops once burned 12 cores for hours after their
session was torn down.

## `release:ci` — the automated path

`.github/workflows/release.yml` (`push: main`) mints a token from the `hyperfixation-bot` GitHub
App and hands it to `changesets/action@v2`. With changesets pending, the action opens or updates
the `Version Packages` PR — with the App's token, because a PR opened with `GITHUB_TOKEN` triggers
no workflows and this repo's ruleset requires `test`, `downstream` and `changeset`. With none
pending, it runs `pnpm release:ci`, which:

1. reads the version off the fixed group's manifests — the checkout *is* the release commit — and
   refuses a group that disagrees with itself;
2. asks the registry for every per-version document first. All nine already `200` means the push
   carried no changesets: it publishes, tags and opens nothing, and exits 0 before even building;
3. `pnpm -r build`, `pnpm -r pack`, then the `workspace:` leftover check on the packed manifests;
4. `npm publish <tarball> --provenance --access public` per package in dependency order, skipping
   any already at `200`. No `NPM_TOKEN`: the credential is the OIDC token npm mints per run against
   the trusted publisher each package names for this workflow file, so there is nothing to leak.
   npm ≥ 11.5.1 is the documented OIDC client, hence the `npm install -g npm@11` step;
5. `release:verify`'s registry check — every version document present, its `dist.integrity` equal
   to the tarball packed from this commit, with the same three-minute 404 backoff;
6. pushes tag `v<version>`, unless it is already there;
7. for every line of `downstream.txt`, clones with the App token, `pnpm update --latest` on that
   repo's `@hyperfixation/*` set, and opens `core-bump/<version>`. An existing branch or an
   existing PR for that version is left alone, so a re-run opens nothing. This replaces the
   `repository_dispatch` route: one App key, held only by core, instead of one per app.

`--dry-run` (the `dry_run` input on `workflow_dispatch`) takes it as far as
`npm publish --dry-run`: no verification, no tag, no bump PRs.

Adding a downstream repo means two files: `downstream.txt` and the `repositories:` list the App
token step passes.

`release:publish` and `release:rehearse` stay until the first OIDC release has actually gone
through this path; then they go and `release:verify` remains, because it is the check that does not
care who did the publishing.
