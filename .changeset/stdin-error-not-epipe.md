---
"@hyperfixation/cli": patch
---

`spawnCollecting` now surfaces a non-EPIPE stdin error through the exec promise instead of swallowing it.
