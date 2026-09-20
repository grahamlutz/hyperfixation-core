---
"@hyperfixation/cli": patch
---

The cloud `langfuse` step no longer needs an organization-scoped key, which is a Langfuse paid-plan feature: `HF_LANGFUSE_ORG_KEY` is optional, the new `HF_LANGFUSE_PUBLIC_KEY`/`HF_LANGFUSE_SECRET_KEY` pair is recorded as the app's keys without any Langfuse request, and with neither the step warns, adds a closing-checklist line and `hf new` omits `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` from the Coolify environment rather than sending them empty.
