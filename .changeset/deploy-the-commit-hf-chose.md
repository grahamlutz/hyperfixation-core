---
"@hyperfixation/cli": patch
---

Coolify never told the app which commit it built. Its docker-compose build pack passes no
`SOURCE_COMMIT` build arg, puts nothing in the compose environment and leaves no `.git` in the
build context, so `HF_BUILD_SHA` was unresolved and the worker refused to start. The `deploy`
step now writes the commit being deployed into the application's own `SOURCE_COMMIT` environment
entry — buildtime and runtime, every entry Coolify lists under the name — before it asks for a
deployment, and `hf new` creates applications with `is_auto_deploy_enabled: false` so a push can
no longer deploy a commit against a stale value.

New command: `hf deploy <name> [--sha <sha>]` publishes a merge to main through that same path and
waits until `/api/status` reports the sha. `hf doctor`'s version warning now names it.
