---
"@hyperfixation/auth": patch
---

Promote a session only on a passkey it enrolled itself. `upgradeSessionFactor` updated on
`token = $1 AND factor = 'code'` alone, and the WebAuthn ceremony is client-side — so anyone who
could read an admin's inbox could sign in with the emailed code, call the template's
`promoteSession()` action directly without ever touching an authenticator, and hold `factor =
'passkey'` and with it the whole of `/admin/*`. The statement now also requires `EXISTS (SELECT 1
FROM hf_passkey p WHERE p.user_id = hf_session.user_id AND p.created_at >= hf_session.created_at)`
and a live `expires_at`, in the one UPDATE so two concurrent calls still move one row.

The second half of the same hole: a code session could enrol a passkey on an account that already
had one — the attacker's own authenticator, after which the promotion is honest. `createAuth` now
gates `/passkey/generate-register-options` and `/passkey/verify-registration` with a `before`
hook and answers 404, the policy's refusal for something that must not describe itself, when a
code session's user holds a passkey older than the session. A passkey session may add another,
and `resetSecondFactor` still reopens enrolment because it deletes the rows and every session
with them. New exports: `mayEnrolPasskey`, `PASSKEY_REGISTRATION_OPTIONS_PATH`,
`PASSKEY_REGISTRATION_PATHS`. Patch: `etc/auth.api.md` changes only additively.
