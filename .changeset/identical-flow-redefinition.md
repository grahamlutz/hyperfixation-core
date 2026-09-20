---
"@hyperfixation/workflows": patch
---

`defineFlow` treats an identical re-definition as the definition it already has. The first real
deployment died on `DuplicateFlow: a flow named "collectDemoSource" is already defined` right after
a passkey enrolment: the page runs a `"use server"` action and then re-renders, so Next instantiates
the app's `src/flows/*.ts` once per module layer — rsc page and server action — in one process,
while this package is a `serverExternalPackages` external and therefore singular. The second layer's
call reached a registry that already held the name. A second call now matches the name against the
first definition's fingerprint — the options, key order ignored, and `fn.toString()` — and on a match
returns the first flow's handle without a second `DBOS.registerWorkflow`. Two genuinely different
definitions of one name still throw `DuplicateFlow` with the same message. A closed-over value that
differs between the two module copies is invisible to the fingerprint; that is its known limit.
