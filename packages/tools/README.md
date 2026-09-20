# @hyperfixation/tools

Private maintainer scripts. Nothing here ships to users; product commands belong in
`packages/cli`. Run them from the repo root.

## Releasing

```sh
pnpm release:rehearse 0.1.1     # the whole path against a throwaway Verdaccio
pnpm release:publish  0.1.2     # the real one, in a visible terminal
pnpm release:verify   0.1.2     # what was published is what main says
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

## FUTURE: the OIDC bridge (Phase 4)

Not built yet — no `release.yml` exists. When the trusted-publisher route replaces the manual
publish:

1. Per package on npmjs.com, nine times, user-performed: Package settings → Publishing access →
   Trusted publisher → GitHub Actions, repository `grahamlutz/hyperfixation-core`, workflow
   `release.yml`, environment blank.
2. Add `release.yml`: `on: push: branches: [main]`,
   `permissions: { contents: write, pull-requests: write, id-token: write }`, and
   `changesets/action@v1` with `version: pnpm changeset version` and
   `publish: pnpm -r publish --access public --provenance --no-git-checks`. No `NPM_TOKEN` — the
   OIDC token is minted per run, so there is never a 2FA-bypass token to leak.
3. Cut over only once `release:rehearse` is green **and** one real publish has gone through
   `release:publish`.

After the cutover `release:publish` and `release:rehearse` go away and `release:verify` stays: it
is the check that does not care who did the publishing.
