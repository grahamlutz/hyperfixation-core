# Vendored OpenAPI documents

These five documents are what `src/test-support/openapi.ts` validates every mocked provider
request against, so a client method that drifts from the real API fails a test instead of a
deploy. They are **trimmed**: only the operations the CLI issues survive, plus the
`#/components/…` entries those operations reach transitively. Everything kept is copied verbatim
from upstream — no hand-edits, no invented fields. Adding an endpoint means re-trimming from the
upstream document, not writing a path by hand.

`openapi-request-validator` validates the request half only (path parameters, query, body), so
the response schemas here are documentation for the code that parses them rather than something
the harness enforces.

| File | Source | Commit | Fetched | `info.version` |
| --- | --- | --- | --- | --- |
| `coolify.json` | `coollabsio/coolify` `openapi.json` at tag `v4.3.21` | `113a2f229d7fa2391119d9acf149e9b0b70382f5` | 2026-09-20 | 0.1 |
| `cloudflare.json` | `cloudflare/api-schemas` `openapi.json` | `efeb8ebf9cf8c844a208cdd0620ac9fd3d97c3ac` | 2026-09-19 | 4.0.0 |
| `github.json` | `github/rest-api-description` `descriptions/api.github.com/api.github.com.json` | `814de7ac96e215adeeec999308f41f98f94a15db` | 2026-09-19 | 1.1.4 |
| `sentry.json` | `getsentry/sentry-api-schema` `openapi-derefed.json` | `ea6ffa7ea4ed5ab5351ad3860e3e21ab4d67bfda` | 2026-09-19 | v0 |
| `langfuse.json` | `langfuse/langfuse` `web/public/generated/api/openapi.yml` | `be747a7d25079858dfe950a9cfe22ea05f9946bb` | 2026-09-19 | (unset) |

Each was taken from `https://raw.githubusercontent.com/<repo>/<ref>/<path>` and pinned to the
commit above — `main` on 2026-09-19 for four of them, and the `v4.3.21` tag for `coolify.json`. Langfuse publishes YAML; it was parsed and re-emitted as JSON so the
harness loads all five the same way — the document is otherwise unchanged.

An operation added later is merged in from the **same** pinned commit, verbatim, alongside the
components it newly reaches; nothing already vendored is rewritten. Re-trimming wholesale would
reshuffle every key in the file for no change in meaning, which buries the addition in the diff.
A new upstream commit is a different job: bump the row above, re-trim, and say so here.

> **`coolify.json` is the box's own Coolify version**, re-vendored on 2026-09-20 from `openapi.json`
> at tag `v4.3.21` — the box serves no document of its own. Across the thirteen operations first kept, the
> tag and the `main` commit vendored before it are identical field for field, so the trimmed file
> did not change; only the row above did. `POST /projects/{uuid}/environments`,
> `PATCH /databases/{uuid}/backups/{scheduled_backup_uuid}` and `GET /s3-storages` were merged in
> later from the same tag, verbatim — the last two carry only the verb the CLI issues, and the
> file's own key order is untouched because the merge is textual (a JSON round trip reorders the
> integer-like response codes).
>
> A green test still proves less than it looks. Coolify enforces rules its document does not
> express: a `dockercompose` application is refused `domains` outright (422, *"Use
> docker_compose_domains instead"*) while the schema lists both fields side by side. That one is in
> `src/test-support/openapi.ts` as an explicit rule, because putting it in the document here would
> be inventing a field upstream does not have. The next one will be found the same way — by the box:
> `POST /databases/{uuid}/backups` says `s3_storage_uuid` is "required if save_s3 is true" in a
> description a validator cannot read, and Coolify accepts the request without it, then disables the
> upload at run time and keeps the dump on the box.

## Operations kept

| Spec | Operation | Used by |
| --- | --- | --- |
| coolify | `POST /projects`, `GET /projects`, `GET /projects/{uuid}` | E3 — the app's Coolify project, found by name on a rerun |
| coolify | `GET`/`POST /projects/{uuid}/environments` | E3 — the app's `production` environment, created when the project has none |
| coolify | `GET /applications` | E3 — the application, found by name on a rerun |
| coolify | `POST /applications/private-github-app` | E3 — the application, from the private repo |
| coolify | `PATCH /applications/{uuid}/envs/bulk` | E3 — `REQUIRED_ENV` in one call |
| coolify | `POST /deploy`, `GET /deployments/{uuid}` | E3 — deploy and poll |
| coolify | `POST /databases/{uuid}/backups` | E3 — backup registration |
| coolify | `GET /databases/{uuid}/backups` | E3 — the schedule an earlier run left; E5 — the registered backups |
| coolify | `PATCH /databases/{uuid}/backups/{scheduled_backup_uuid}` | E3 — that schedule's S3 settings, rather than a second schedule |
| coolify | `GET /s3-storages` | E3 — the storage the daily dump is uploaded to |
| coolify | `GET`/`PATCH /databases/{uuid}` | E2 — the Postgres resource, and `is_public`/`public_port` |
| cloudflare | `GET`/`POST /zones/{zone_id}/dns_records` | E3 — the `A` record |
| github | `POST /user/repos`, `POST /orgs/{org}/repos` | E3 — the app's private repo |
| github | `GET /users/{username}` | E3 — whether `HF_GITHUB_OWNER` is an account or an org |
| github | `GET /repos/{owner}/{repo}` | E3 — whether the repository is already there |
| github | `GET /user/installations`, `GET /user/installations/{installation_id}/repositories` | E3 — both GitHub Apps installed on it |
| github | `GET /repos/{owner}/{repo}/git/ref/{ref}` | E4 — `main`'s sha |
| github | `GET /repos/{owner}/{repo}/pulls` | E4 — open `core-bump/*` PRs |
| github | `GET /repos/{owner}/{repo}/commits/{ref}/status` | E4 — those PRs' checks |
| sentry | `POST /api/0/organizations/{org}/projects/` | E3 — the Sentry project |
| sentry | `GET /api/0/projects/{org}/{project}/keys/` | E3 — the DSN |
| langfuse | `POST /api/public/projects`, `GET /api/public/projects` | E3 — the Langfuse project, found by name on a rerun |
| langfuse | `POST /api/public/projects/{projectId}/apiKeys` | E3 — its key pair |

Two Coolify responses are documented as `"Content is very complex. Will be implemented later."` —
`GET /databases/{uuid}` and `GET /databases/{uuid}/backups` — so the harness validates those
*requests* and the client returns `unknown`. Nothing in the
document attaches a database to a docker network either: `PATCH /databases/{uuid}` reaches
`is_public` and `public_port` and no further, which is why the Postgres container's hostname on
the network is `HF_DB_HOST_INTERNAL` in the operator's config rather than something read back.
