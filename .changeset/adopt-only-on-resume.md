---
"@hyperfixation/cli": patch
---

The cloud `template` step no longer adopts an app directory that already exists on a first run.
It adopted any directory whose `package.json` named the app, so a scaffold left by an earlier
`hf new --local` was committed and pushed as if it were this run's — and Coolify's build then
failed on its stale `pnpm-workspace.yaml`. Adoption now needs the state cache to say the step
began (`templateStartedAt`, written just before the rename) or finished; otherwise `hf new`
fails with a `TemplateError` telling the operator to move the directory away.
