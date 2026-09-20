---
"@hyperfixation/auth": patch
---

`evaluateAccess` reads `banExpires`, so a ban that has lapsed stops 404ing the user out of
`/admin` and `/w`. Banned now means what the notifier's SQL already meant — `banned IS TRUE AND
(ban_expires IS NULL OR ban_expires > now())` — and `AccessRequest.now` injects the clock.
