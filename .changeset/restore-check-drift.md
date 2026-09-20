---
"@hyperfixation/cli": patch
---

`hf restore-check` no longer reads a running app's own churn as data loss. Against a 1.3-hour-old
dump of `demo-app`, X1 reported 9 of 24 tables mismatched — `hf_run` 30 against 3, `hf_activity` 2
against 0 — and the same check against a fresh dump matched all 24: every one of those tables had
simply gained rows since the dump was taken. A committed list, `APPEND_ONLY_TABLES`, names the
eight `hf_*` tables no code path deletes from and none updates in a way that lowers their count,
and for those a restored count *below* the live one is now `ok (drift +N)` rather than a
mismatch. A restored count above the live one stays a mismatch there — that is the data loss the
command exists to catch — and every other table, including one that merely looks append-only, is
still compared exactly. `--strict` drops the allowance and compares everything exactly.

A dump older than 24 h (was 36 h) now prints a `WARN` line and, following `hf doctor`, exits 1:
a check against stale data is not a passing check. `RestoreCheckResult` gains `strict` and
`matched` — no table failed, which is what `lastRestoreCheckAt` is written on — alongside `ok`,
which is now `matched` and a fresh dump; `RestoreCheckRow` gains `drift`. `RestoreVerdict` is
unchanged: drift is not its own outcome, it is an `ok` the table prints a reason beside.
