---
"@hyperfixation/workflows": patch
---

Compare two definitions of a flow name by a normalised token stream instead of by `fn.toString()`,
so `defineFlow`'s idempotency survives a real bundler. #103 made an identical re-definition return
the flow it already defined, but "identical" meant character for character, and the two module
layers of one route never are: `next build --webpack` compiles a route's graph once per layer and
minifies each with its own name budget. The template's `collectDemoSource` arrives in the page
layer and in the server-action layer differing in five tokens — three renamed import bindings, one
renamed local, and the webpack module id of the body's own `await import(…)`, which is a *number* —
so every definition still collided and any route loading the flows in a second layer crashed with
`DuplicateFlow`. The comparison now normalises identifiers to positional placeholders and numeric
literals to one placeholder, keeping property names, string, regex and template text, keywords,
operators and the shape; both compiled layers are committed as fixtures under
`packages/workflows/src/__fixtures__/`. Two genuinely different flows of one name — a differing
string, statement, operator, property or option — still throw `DuplicateFlow` with the message they
always had. `DefineFlowOptions.version` is the new optional escape hatch for the one build this
cannot see through, a minifier that mangles property access as well as identifiers: state it and the
bodies are not compared at all, while a second `version` of one name is still a collision. It is the
only added API and nothing already exported changed shape.
