# Two module layers of one flow

`layer-rsc-page.collect-demo-source.js.txt` and `layer-server-action.collect-demo-source.js.txt`
are the same flow body — the template's `collectDemoSource` — as `next build --webpack` compiled it
into the two module layers of `/auth/passkey`. They are what `flow-fingerprint.test.ts` pins:
`fn.toString()` of one source, twice, not matching character for character.

They came out of a real build, not by hand. To regenerate:

1. Clone `grahamlutz/hyperfixation-template` and `pnpm install --frozen-lockfile`.
2. Undo the `src/pool.ts` split that template PR #50 made — have `src/auth.ts` take `pool` from
   `src/web.ts` — so the session guard carries the app and its flows into every route again, and
   `/auth/passkey` instantiates them in both its page layer and its server-action layer.
3. `pnpm exec next build --webpack`. The prerender step fails on a missing `APP_URL`, which does
   not matter: compilation has already emitted both layers.
4. The page layer's copy is in `.next/server/app/(auth)/auth/passkey/page.js` and the action
   layer's is in the shared `.next/server/chunks/<id>.js`. Take the second argument of each
   `defineFlow)("collectDemoSource",` call.

The five differing tokens are three renamed bindings, one renamed local, and — the one the plan for
this work did not expect — the webpack module id of the body's `await import("../hyperfixation")`,
which is a *numeric* literal. That is why `normalizeFunctionSource` cannot keep numbers.
