---
"@hyperfixation/db": patch
"@hyperfixation/core": patch
"@hyperfixation/workflows": patch
---

Bill a period at the ledger's own scale. `hf_budget_period.spent_usd` was `numeric(12,4)` while
`hf_llm_call.cost_usd` is `numeric(12,6)`, and every settle is `spent_usd = spent_usd + cost_usd`,
so each sub-cent call rounded the running total and the error grew with the number of calls — the
first two real provider calls on the X1 box reported a `$0.000007` drift and a `degraded` status.
Migration `0009_budget_spent_scale` widens the column to `numeric(12,6)` and repairs the rounding
already stored. `/api/status` and `reconcile()` now subtract in Postgres at that scale, so
`spentUsd`, `ledgerUsd` and `driftUsd` all print six decimals and a settled period drifts by
exactly `0.000000`.
