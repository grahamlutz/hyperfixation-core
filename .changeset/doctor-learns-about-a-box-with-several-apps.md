---
"@hyperfixation/cli": patch
---

`hf doctor` gains two findings per app, read over the tunnel E006 already opens. `connections`
counts every backend belonging to an `hf_*` role against the one `max_connections` the box's apps
share — a `WARN` past 80% of it — and shows the app's own role against its `CONNECTION LIMIT` of
25. `lock` counts the advisory locks in the app's database and checks that exactly one is held
under `hashtext('hf-worker:' || <app>)`, the key `acquireWorkerLock` takes: none means no live
worker and two means two, and both are a `FAIL`. Neither needs operator config, and a query that
refuses is a `FAIL` line rather than a dead command.
