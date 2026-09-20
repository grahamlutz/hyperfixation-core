---
"@hyperfixation/cli": patch
---

The cloud `coolify` step creates the `production` environment when the Coolify project has none,
through `POST /projects/{uuid}/environments` (`CoolifyClient.createEnvironment`), instead of
failing with "the API has no endpoint that creates one" — Coolify documents that endpoint, and
the vendored OpenAPI document now keeps its `post` operation.
