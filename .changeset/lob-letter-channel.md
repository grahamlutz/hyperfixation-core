---
"@hyperfixation/workflows": patch
---

`lobChannel` mails one letter per `actions.perform` through Lob's `POST /v1/letters`, carrying the
action's own `idempotencyKey` as the request's `Idempotency-Key` — which is what its `dedupes: true`
rests on, and only for the 24 h Lob honours the header. That bound is now enforced rather than
documented: `ActionChannel` gains an optional `dedupeWindowMs`, `lobChannel` declares
`LOB_IDEMPOTENCY_WINDOW_MS`, and `perform` routes a re-entry older than a channel's window to the
`uncertain` path — a task for a human — instead of re-sending under a key the provider has
forgotten. A channel that declares no window dedupes forever, as before. `reconcile`'s sweep now
also moves `failed` action rows, not only `started` ones, so a send that threw after the provider
accepted it cannot sit outside every review path.

The letter is `renderToStaticMarkup` of a page whose draft fields are text nodes, so a draft
carrying `<img src=x onerror=…>` is printed as those characters rather than reaching Lob as markup;
nothing interpolates a draft into HTML. `LOB_API_KEY` goes out as Basic auth's username and appears
on no error: `LobRefused` names the status and Lob's own `error.message` with the key blanked in
every form it could be quoted back in — the raw key, the bare base64 credential, and any encoding of
the key with something appended, matched by base64 prefix rather than by exact string. A `live_` key
is refused outright unless the channel was built with `live: true`, so Phase 6 mails test-mode paper
only. The request is parsed against `LobLetterRequest`, or against the app's own draft schema when
one is passed — that is where a contact allowlist lives. Adds `react` and `react-dom` to this
package's dependencies for the renderer.
