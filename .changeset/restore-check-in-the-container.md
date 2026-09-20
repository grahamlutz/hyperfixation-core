---
"@hyperfixation/cli": patch
---

`hf restore-check` runs `pg_restore` inside the Postgres container instead of on the box host.
The host has no Postgres client tools — Coolify runs Postgres only in a container — so the real
run exited 127 with `pg_restore: command not found`. The restore is now
`docker exec -i <container> pg_restore --no-owner --no-comments --role=<migrator> -U <admin>
-d <scratch>` with the host's dump streamed on stdin, since the dump is not mounted into the
container; the container comes from the same discovery the tunnel uses (`HF_DB_CONTAINER`, or
`HF_COOLIFY_POSTGRES_UUID`) and the admin from `HF_PG_ADMIN_USER`. Exit 127 now says what it
means and what to check. `Runner.exec` takes an `inputFile`, which on `ssh` becomes the remote
shell's own `<` redirection. `RestoreCheckOptions.restoreAdminUrl` and `pgRestoreArgv` are
deprecated; `pgRestoreInContainerArgv` and `findPostgresContainer` replace them.
