---
"@hyperfixation/auth": patch
"@hyperfixation/db": patch
---

Promote a session only on a passkey **that session** enrolled, and let a code session near nothing
else in the passkey plugin. `upgradeSessionFactor` updated on `token = $1 AND factor = 'code'`
alone, and the WebAuthn ceremony is client-side — so anyone who could read an admin's inbox could
sign in with the emailed code, call the template's `promoteSession()` action without ever touching
an authenticator, and hold `factor = 'passkey'` and with it the whole of `/admin/*`.

Two things had to be shut, and the first attempt at each was wrong:

- **Every authenticated `/passkey/*` endpoint, not just the two registration ones.** The plugin
  also exposes `list-user-passkeys`, `delete-passkey` and `update-passkey`, each guarded on a
  session and — on two of them — resource ownership, never a factor. A code session could list the
  victim's passkey ids, delete them, and so become a "first enrolment" again, at which point
  enrolling its own authenticator and promoting was honest. The gate is now an inversion:
  `isGuardedPasskeyPath` covers every `/passkey/*` path but the two unauthenticated sign-in ones,
  so an endpoint a plugin upgrade adds is refused by default. A code session may reach
  `generate-register-options` and `verify-registration`, and only while its user holds **zero**
  passkeys; everything else answers 404, the policy's refusal for something that must not describe
  itself. A passkey session may drive all of them.
- **The promotion has to be bound to a session, not to a clock.** `EXISTS (… p.created_at >=
  hf_session.created_at)` was a time comparison: an attacker's idle code session promoted itself
  the moment the victim legitimately added a second device from their own passkey session. There is
  now a nullable `hf_session.passkey_enrolled_at`, stamped by a `hooks.after` on
  `/passkey/verify-registration` on the *calling* session and only when the plugin returned a
  verified registration — better-auth runs after-hooks over a thrown `APIError` too. The statement
  is `… WHERE token = $1 AND factor = 'code' AND expires_at > now() AND passkey_enrolled_at IS NOT
  NULL AND EXISTS (SELECT 1 FROM hf_passkey p WHERE p.user_id = hf_session.user_id)`, one UPDATE so
  two concurrent calls still move one row.

`resetSecondFactor` remains the only code-path recovery and still reopens enrolment, because it
deletes the passkeys and every session with them.

New exports: `mayEnrolPasskey`, `isGuardedPasskeyPath`, `PASSKEY_REGISTRATION_OPTIONS_PATH`,
`PASSKEY_REGISTRATION_PATHS`, `PASSKEY_AUTHENTICATION_OPTIONS_PATH`, `PASSKEY_SIGN_IN_PATHS`.
Patch, not minor, on both counts the policy names: `etc/*.api.md` changes only additively, and core
migration `0010_session_passkey_enrolled_at` adds a nullable column, which N-1's readers do not
read and cannot trip over. Existing code sessions carry `NULL` and simply cannot promote until a
fresh enrolment; no backfill.
