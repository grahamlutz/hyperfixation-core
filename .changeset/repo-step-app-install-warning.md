---
"@hyperfixation/cli": patch
---

The cloud `repo` step no longer aborts a run when the token may not list GitHub App installations: a 401/403/404 from `GET /user/installations` now records the step and warns, naming each `HF_GITHUB_APP_SLUGS` entry and its install URL in the warning and in the closing checklist.
