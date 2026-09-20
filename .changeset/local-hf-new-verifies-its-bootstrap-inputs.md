---
"@hyperfixation/cli": patch
---

`hf new --local` now refuses a missing `--budget-usd` or `--email` up front, exactly as the
cloud path has since Phase 3, and writes the budget to the new app's `.env` as
`HF_BOOTSTRAP_BUDGET_USD`. The local half asked for the address at an interactive prompt and
never asked for a budget at all, which left `hf up` to seed its own dev default — an app
running under a cap nobody chose, and a `hf new --local` that could not be run unattended at
all. `newApp` takes the budget as `budgetUsd` and reports it as `wroteBootstrapBudget`; the
prompt is still there for a caller that supplies its own.
