---
"@hyperfixation/cli": patch
---

`hf --version` (also `-v` and `hf version`) prints the `@hyperfixation/cli` version, read from the
package's own `package.json` at runtime so a release cannot leave it behind. And a `hf new` that
finds something in its way now names the absolute path and the one move that clears it, for both
directories it cares about: the app directory, and the dot-prefixed `.<name>.hf-new` scratch beside
it. The scratch is cleared only on a genuine resume — the state cache records the fetch's start the
way it already records the rename's — so a first run refuses one it has no record of creating
instead of deleting a directory that was never hf's.
