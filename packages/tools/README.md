# @hyperfixation/tools

Private maintainer scripts. Nothing here ships to users; product commands belong in
`packages/cli`. Run them from the repo root.

## Releasing

```sh
pnpm release:rehearse 0.1.1     # the whole path against a throwaway Verdaccio
pnpm release:publish  0.1.2     # the manual one, in a visible terminal
pnpm release:verify   0.1.2     # what was published is what main says
pnpm release:ci                 # what .github/workflows/release.yml runs; not for a laptop
pnpm release:bump               # one downstream bump PR, one token; the same
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

`release:verify` asks whether the tarballs the registry serves for `<version>` were built from the
release commit — its tag, else the commit that bumped the manifests on `origin/main`. Both are
local refs, so it runs `git fetch origin main --tags` first and refuses to continue if that fails:
a checkout that had not fetched since the publish resolved a pre-release commit on 2026-09-20 and
reported all nine packages of 0.1.2 as mismatched. `--no-fetch` accepts the refs already in the
checkout, and every difference it reports names the commit it rebuilt. For a version
published by `release.yml` the answer is the **provenance attestation**, and that is the gate:

- the SLSA statement at `/-/npm/v1/attestations/<pkg>@<version>` is decoded, and its subject
  digest, converted from hex to `sha512-<base64>`, must equal the registry's `dist.integrity`;
- its `buildDefinition.externalParameters.workflow` must name `grahamlutz/hyperfixation-core` and
  `.github/workflows/release.yml`, and its `resolvedDependencies` must carry the release commit's
  `gitCommit`. A tarball built by any other workflow, repo or commit fails here;
- `npm audit signatures`, run over a throwaway project with the attested packages installed, is
  what verifies the Sigstore bundle and npm's registry signature *cryptographically* — decoding a
  DSSE payload proves nothing about its signature. It needs an install tree rather than a flag,
  which is why it gets its own temp project. Anything it puts in `invalid`, or any
  `@hyperfixation/*` in `missing`, is a failure.

Together those prove the published bytes are the ones GitHub Actions built from this repo at that
commit — which is a stronger claim than a rebuild on the maintainer's laptop ever made, and the
only one that holds when publisher and verifier are different machines.

A rebuild of the release commit in a throwaway `git worktree` is still installed, built and packed
— it is what the `workspace:` leftover check reads, and it is the only evidence for a version with
no attestation (`0.1.0`, `0.1.1`), where a byte difference still fails. For an **attested** version
a byte difference is reported as a `warnings:` line and does not fail the run: the attestation
already pins the tarball, so a difference there is a difference between two builds, not a bad
publish. The 0.1.1 verification reported a false integrity mismatch for the CLI because it packed a
feature branch; demoting the comparison is what stops that class of report from reading as a
compromised release.

A `404` on a version document is retried with backoff for three minutes before it counts as
missing: after a publish npmjs answers `npm view` at once but 404s the per-version document for
about a minute.

## The removal gate

```sh
pnpm api:diff
```

Reads every committed `etc/*.api.md` at the merge base and at HEAD and fails a member that left or
changed shape without the two releases
[the versioning policy](../../planning/hyperfixation-versioning-policy.md) requires: a
`deprecations.json` entry whose window covers this release, an `@deprecated` tag in the *baseline*
report, and a minor changeset. Additions and reorderings are noise, and pass.

A const whose printed type is a set of string literals — `COMMANDS: readonly ["new", …]` in
`packages/cli/etc/cli.api.md` — is compared as a set: the new one must be a superset, so a command
can be added but not dropped. A dropped one is reported as `COMMANDS.deploy removed`, and that
dotted name is what a `deprecations.json` row has to carry:

```json
{ "package": "@hyperfixation/cli", "symbol": "COMMANDS.deploy", "since": "0.1.4", "removeIn": "0.2.0" }
```

A tuple member cannot carry an `@deprecated` tag of its own, so the entry is the whole
announcement and only the minor changeset is still required. The `USAGE` const beside it is a
single long string that every added command reprints; its contents are exempt, and `COMMANDS` is
what catches a command that actually left.

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
5. every version document present, its `dist.integrity` equal to the tarball packed in step 3,
   with the same three-minute 404 backoff. Here the byte comparison is still a gate rather than a
   warning, because the tarball it compares is the one this run just uploaded;
6. pushes tag `v<version>`, unless it is already there;
7. waits, with the same three-minute backoff, until the **abbreviated packument**
   (`Accept: application/vnd.npm.install-v1+json`) lists `<version>` and carries it as
   `dist-tags.latest` for all nine. That is the document an installer resolves from, and npmjs
   serves it from a different cache than the per-version document: at `0.1.8` all nine per-version
   documents were `200` while the packument for the three published last still named `0.1.7`, so
   the template's bump PR pinned `admin`, `auth` and `cli` a release behind. A package still
   missing when the window is spent fails the job by name, before any PR is opened;
8. writes `--result` and stops. The bump PRs are opened by `release:bump`, below.

`--dry-run` (the `dry_run` input on `workflow_dispatch`) takes it as far as
`npm publish --dry-run`: no verification, no tag, no bump PRs.

## `release:bump` — one downstream repo, one token

`release.yml`'s `bump` job is a matrix over `downstream.txt` — the same `downstream:matrix` reader
`ci.yml` uses, so adding a repo is one file. Each entry gets its own job, its own
`create-github-app-token` scoped to that one repository, and one `pnpm release:bump --repo
<owner/repo> --version <version>`, which clones with that token, runs
`pnpm update '@hyperfixation/*@<version>' --ignore-scripts --ignore-pnpmfile` and opens
`core-bump/<version>`. Pinned, because `--latest` quietly resolves whatever the packument names.
Before committing it asserts in-process that every `@hyperfixation/*` in the app's `dependencies`
and `devDependencies` is on `<version>` and that the lockfile resolves no other one. An existing
branch or an existing PR for that version is left alone, so a re-run opens nothing.

Three things about that job are the point rather than an accident, and each has a test:

- **One repo per token.** The job runs `pnpm update` inside someone else's checkout. A token that
  also reached core would let any app repo push to core's main and have the next release publish
  from it. The publishing job's token is scoped to `hyperfixation-core` alone, and it never shares
  a job with a downstream one — which is why the bump is a job of its own and not a step.
- **`--ignore-scripts --ignore-pnpmfile`.** Without them that repo's `.pnpmfile.cjs` and every
  dependency build script run here, holding the token. `pnpm-guards.test.ts` runs the real pnpm
  against a fixture that writes a marker file from both.
- **A downstream repo with a pnpmfile is refused, not updated.** `--ignore-pnpmfile` also *deletes*
  the lockfile's `pnpmfileChecksum`, and the app's own `pnpm install --frozen-lockfile` then fails
  with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` — so the bump PR would open red and stay red, while
  dropping the flag is the hole above. Neither is acceptable, so the bump fails that one repo by
  name, before the update, and says why; `fail-fast: false` leaves the rest to open theirs. Checked
  for are the two names pnpm 12.4.2 actually loads — `.pnpmfile.cjs` and `.pnpmfile.mjs`, not
  `pnpmfile.js` — and whatever `pnpm-workspace.yaml`'s `pnpmfile:` setting points at, which pnpm
  runs and checksums just the same. No downstream repo has one today, which is why it is asserted:
  nothing else would notice until a release had already opened the PR. `pnpm-guards.test.ts`
  measures the checksum round-trip against the real pnpm, offline.
- **No credential in the URL or in `.git/config`.** Every git call goes through
  `git -c http.extraheader='AUTHORIZATION: basic …'` *before* the subcommand, which is
  process-scoped; `git clone -c` would write it into the clone. `redact()` strips it, and any
  known secret environment value, out of every error message and log line.

A repo that refuses its bump fails its own matrix job; `fail-fast: false` leaves the others to
open theirs.

## Action pins

Every third-party `uses:` is pinned to a commit SHA with a `# vX.Y.Z` comment, because a tag is a
pointer its owner can repoint at any commit. `workflow-pins.test.ts` scans `.yml` **and** `.yaml`
under `.github/workflows`, plus every `.github/actions/**/action.y*ml` — a composite action runs
with the privileges of the job that calls it — and fails a `uses:` that is not 40 hex characters or
carries no version comment.

The comment alone proves nothing: a wrong SHA wearing a right-looking `# v4.4.0` passed all of
that, because nothing related the two. `src/workflow-pins.json` is that relation, written down
once:

```json
{ "actions/checkout": { "11d5960a326750d5838078e36cf38b85af677262": "v4.4.0" } }
```

The test asserts every pin appears in the table at the same version, and that the table keeps no
entry the workflows have stopped using — so bumping a pin means editing both, and a mismatched
pairing fails CI. Add the new SHA to the table in the same commit as the workflow.

```sh
pnpm pins:verify
```

Resolves each table entry's tag through `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha` and
reports anything that no longer matches. It needs the network and an authenticated `gh`, so no CI
job runs it: the table is the offline check, this is the one against the world. Run it when bumping
a pin. A moved tag is not by itself a compromise — an owner may have re-tagged — but the pin is then
no longer the commit anyone reviewed, so re-read the diff before following it.

`release:publish` and `release:rehearse` stay until the first OIDC release has actually gone
through this path; then they go and `release:verify` remains, because it is the check that does not
care who did the publishing.
