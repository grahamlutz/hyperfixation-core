---
"@hyperfixation/cli": patch
---

The cloud `backup` step sends the dump off the box. It registered the schedule with `save_s3: true`
and no `s3_storage_uuid`, which Coolify 4.3.21 accepts and then runs with `S3 storage configuration
is missing`, keeping the only copy on the same disk as the database. The storage is now resolved
first — the new optional `HF_COOLIFY_S3_STORAGE_UUID`, else the one `is_usable` entry
`GET /s3-storages` lists — and sent with `save_s3: true`. With no usable storage, or more than one,
the step registers `save_s3: false` and says so in a `WARNING:` and the closing checklist rather
than guessing. It is also idempotent now: the database's schedules are listed and this app's is
PATCHed through `PATCH /databases/{uuid}/backups/{scheduled_backup_uuid}`, so a rerun no longer
leaves a second one. Both operations were merged into the vendored Coolify document from its pinned
`v4.3.21` tag.
