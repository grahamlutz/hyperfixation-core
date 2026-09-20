Chunk: <id from the current phase-order doc, e.g. E3; `misc` for work no chunk asked for>

<!--
Keep the `Chunk:` line first and on its own: `pnpm plan:sync` reads it to build the status table
in planning/hyperfixation-phase*-order-*.md. A PR without one never reaches the table.
-->

What this changes, and why, in a few lines.

## Built

Deviations from the plan, findings, timings. This is the note that used to be a follow-up docs
PR — the order doc's prose stays reserved for deviations and decisions, and `plan:sync` never
copies this section into it.
