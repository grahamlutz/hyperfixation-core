---
"@hyperfixation/cli": patch
---

The cluster tunnel discovers its target instead of assuming the box's loopback: Coolify publishes
no port for its Postgres, so when `127.0.0.1:5432` carries no query the runner asks
`docker inspect` for the container's address on the `coolify` network and forwards to that, with
the box as the hop. `hf new`, `hf doctor`'s E006 and `hf restore-check` all take the discovered
address, `pg_restore` included. Two new optional config keys: `HF_DB_CONTAINER`, which replaces
the pair of container names derived from `HF_COOLIFY_POSTGRES_UUID`, and `HF_PG_ADMIN_USER`, for a
cluster whose superuser is not `postgres`.
