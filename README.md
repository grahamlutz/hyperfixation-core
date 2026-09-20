# hyperfixation

A framework for spinning up small AI-workflow apps — one person plus a few non-technical
collaborators — without rebuilding sign-in, admin, approvals, cost tracking, and deploy each time.

Every app runs the same loop: **collect records → score them → draft with an LLM → a human
approves → perform an action** (send an email, mail a letter). Crashes and redeploys never
double-bill or double-send: every LLM call and action is keyed and fenced, so a restarted run
picks up exactly where it stopped.

> **Status:** early. Phase 1 (core skeleton and run model) is done; Phase 2 (the end-to-end demo
> loop, locally) is in progress. Nothing is published to npm yet. See [Roadmap](#roadmap).

## What it will do

Once the plan is fully executed, `hf new my-app` gives you a signed-in web app, a background
worker, and a Postgres database that already run the loop above.

- **Durable workflows.** Define flows and steps that survive crashes, redeploys, and pauses —
  no duplicate LLM calls, no duplicate sends.
- **LLM calls with a budget.** Provider-agnostic `llm.run` with a cost ledger, a per-month budget,
  versioned prompt files, and Langfuse tracing.
- **Human approval.** Batch-approve drafts from a phone-friendly inbox, edit inline, or approve
  over Telegram or email.
- **Actions with safety rails.** Send email, letters (Lob), and messages; ambiguous outcomes are
  flagged for a human instead of retried blindly.
- **Records and pipeline.** Load and dedupe records, track activity, tasks, labels, and outcomes,
  and see them on a pipeline board and per-record timeline.
- **Sign-in and admin.** Emailed-code and passkey sign-in, and an admin area generated from the
  database schema (404 for non-admins).
- **Kill switch and status.** Pause or resume a whole app, and read health from `/api/status`.
- **One command to ship.** `hf new` provisions GitHub, Postgres, Coolify, Cloudflare, Sentry, and
  Langfuse; backups, Metabase, `hf doctor`, and restore checks come with it.
- **Many apps, one core.** Packages publish to npm with API-diff checks, and downstream apps get
  bump PRs automatically; each app is isolated and separately pausable.
- **Channels and learning.** Inbound email replies, cached fetching with rate limits, cadences,
  embedded documents, and digests. The first real app is `business-acquisition`.

## Packages

| Package | Purpose |
| --- | --- |
| [`@hyperfixation/db`](packages/db) | Drizzle schema for every `hf_*` table, migrations, migrator, boot checks |
| [`@hyperfixation/core`](packages/core) | `defineApp`, registries, pause/resume, `records.archive`, status endpoint |
| [`@hyperfixation/ai`](packages/ai) | Provider registry, prompt files, `llm.run` with ledger and budget |
| [`@hyperfixation/workflows`](packages/workflows) | `defineFlow`, `step`, worker, approvals, actions, reconcile |
| [`@hyperfixation/auth`](packages/auth) | Sign-in factory, session-factor policy, bootstrap admin |
| [`@hyperfixation/admin`](packages/admin) | Admin router and resources generated from schema metadata |
| [`@hyperfixation/testing`](packages/testing) | Per-test databases, mock LLM, crash-and-restart harness |
| [`@hyperfixation/cli`](packages/cli) | The `hf` binary |
| [`@hyperfixation/eslint-config`](packages/eslint-config) | Shared lint rules |

A [shadcn registry](registry) for UI components is scaffolded but empty.

## Run it

This repo is the shared core; you develop and test it here. Apps are generated from the sibling
`hyperfixation-template` repo.

**Prerequisites:** Node ≥ 22, pnpm 12.4.2 (`corepack enable`), and Docker (for Postgres).

```bash
pnpm install
```

Tests need a Postgres with pgvector. Start a throwaway one:

```bash
docker run -d --rm --name hf-pg -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg17
export HF_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
```

Each test creates and drops its own database off that connection. Then:

```bash
pnpm test           # builds dependencies, then runs every package's tests
pnpm typecheck
pnpm lint
pnpm api-extractor  # fails if a public API changed without updating etc/*.api.md
```

If you change a public API, regenerate the reports with `pnpm api-extractor:update` and add a
changeset with `pnpm changeset`.

To ask whether an app survives the change, `pnpm template:check` packs these packages and runs
the sibling template checkout's own typecheck and tests against the tarballs (`HF_TEMPLATE_DIR`
to point it elsewhere, `--full` to add its lint and `next build`). CI runs it as `downstream`.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Core skeleton and run model: `db`, `workflows`, `auth`, `admin`, `cli`, redeploy/fence proofs | Done |
| 2 | The demo loop, locally: approval inbox, pipeline board, tasks, Telegram, Langfuse | In progress |
| 3 | Cloud `hf new`, backups, Metabase, `hf doctor` | Planned |
| 4 | npm publish, API-diff gate, automated downstream bumps | Planned |
| 5 | A second app; per-app isolation | Planned |
| 6 | Channels, fetch cache, cadences, documents, digests | Planned |
| 7 | `business-acquisition`: the first real app | Planned |

## Docs

Design and build order live in [`planning/`](planning): the
[master plan](planning/hyperfixation-plan-2026-09-15.md), plus the
[Phase 1](planning/hyperfixation-phase1-order-2026-09-16.md) and
[Phase 2](planning/hyperfixation-phase2-order-2026-09-18.md) implementation orders.
