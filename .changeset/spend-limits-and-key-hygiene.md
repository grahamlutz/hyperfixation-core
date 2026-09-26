---
"@hyperfixation/cli": patch
---

Two commands and a `hf doctor` line for the two things an app's spend and its keys had no handle
on. `hf budget <name> --usd <n>` sets `hf_app_state.budget_usd` — the default every new period is
created from, seeded once by `hf bootstrap` and until now never again — over the tunnel, in one
statement that also writes the `hf_audit` row naming the operator (`app.budget_default_set`,
`hf-cli:<$HF_OPERATOR or login name>`). The period already running is untouched: that ceiling is
the admin form's, and moving both from here would change a month nobody asked about.

`hf rotate-key <name> <VAR>` replaces one of the app's provider or channel variables —
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `SMTP_URL`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET`, `LOB_API_KEY`, and nothing whose rotation also needs a role password or
a signed-out session. The new value is read from stdin rather than an argument, goes out in the one
Coolify request that has to carry it, and is neither printed nor stored: what the state file gains
is `keys.<VAR>.rotatedAt`, a date. A deploy follows, because Coolify holds the new value the moment
the PATCH returns and the running containers hold the old one until they are replaced.

`hf doctor` gains `keys`: one line per provider or channel variable the app's Coolify environment
has, by name, with how long ago `hf rotate-key` last replaced it — `WARN` past 90 days, and `WARN`
for a variable that is set with no rotation recorded, which is what a key set by hand reads as.
