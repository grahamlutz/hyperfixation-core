---
"@hyperfixation/cli": patch
---

`hf doctor` reads an older app's `/api/status` without crashing: a field the deployed core does
not carry — `llm` before 0.1.1, and anything newer — reads as unknown instead of throwing.
`hf new` in the cloud now names every missing operator config key before the first request, not
one failed step at a time.
