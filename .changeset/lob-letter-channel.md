---
"@hyperfixation/workflows": patch
---

`lobChannel` mails one letter per `actions.perform` through Lob's `POST /v1/letters`, carrying the
action's own `idempotencyKey` as the request's `Idempotency-Key` — which is what its `dedupes: true`
rests on, and only for the 24 h Lob honours the header (`LOB_IDEMPOTENCY_WINDOW_MS`; a row
re-entered later than that is still the `uncertain` path's problem, not this channel's). The letter
is `renderToStaticMarkup` of a page whose draft fields are text nodes, so a draft carrying
`<img src=x onerror=…>` is printed as those characters rather than reaching Lob as markup; nothing
interpolates a draft into HTML. `LOB_API_KEY` goes out as Basic auth's username and appears on no
error: `LobRefused` names the status and Lob's own `error.message` with any echo of the key blanked,
and a `live_` key is refused outright unless the channel was built with `live: true`, so Phase 6
mails test-mode paper only. The request is parsed against `LobLetterRequest`, or against the app's
own draft schema when one is passed — that is where a contact allowlist lives. Adds `react` and
`react-dom` to this package's dependencies for the renderer.
