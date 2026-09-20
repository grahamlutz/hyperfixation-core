---
"@hyperfixation/cli": patch
---

The cloud `coolify` step gives the application its domain per compose service, which is the only
way Coolify takes one: a `dockercompose` build pack refuses `domains` outright (422, *"Use
docker_compose_domains instead"*), so `hf new` now sends
`docker_compose_domains: [{ name: "web", domain: "https://<app>.<HF_BASE_DOMAIN>" }]`, `web` being
the compose service the template publishes 3000 from (`COMPOSE_DOMAIN_SERVICE`, beside
`COMPOSE_LOCATION`). A provider's refusal is also readable now: the response's own `message` and
`errors` reach `ProviderError.message` for all five clients, truncated to 500 characters and with
every credential the client holds, every value the request declared and anything shaped like a
password blanked out first. The Coolify OpenAPI document is re-vendored at the box's own release
tag, `v4.3.21`.
