# @hyperfixation/auth

## 0.1.10

### Patch Changes

- Updated dependencies [e9dae6f]
  - @hyperfixation/db@0.1.10

## 0.1.9

### Patch Changes

- 5662f8d: Promote a session only on a passkey **that session** enrolled, and let a code session near nothing
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
    the moment the victim legitimately added a second device from their own passkey session. The
    proof is now a row in the new `hf_session_passkey_enrolment` table, written by a `hooks.after` on
    `/passkey/verify-registration` for the *calling* session and only when the plugin returned a
    verified registration — better-auth runs after-hooks over a thrown `APIError` too. `session_id`
    is the whole key and cascades from `hf_session`, so a second registration from one session is
    inert and the proof cannot outlive the session. The statement is `… WHERE token = $1 AND factor =
    'code' AND expires_at > now() AND EXISTS (SELECT 1 FROM hf_session_passkey_enrolment e WHERE
    e.session_id = hf_session.id) AND EXISTS (SELECT 1 FROM hf_passkey p WHERE p.user_id =
    hf_session.user_id)`, one UPDATE so two concurrent calls still move one row.
  
  `resetSecondFactor` remains the only code-path recovery and still reopens enrolment, because it
  deletes the passkeys and every session with them.
  
  New exports: `mayEnrolPasskey`, `isGuardedPasskeyPath`, `PASSKEY_REGISTRATION_OPTIONS_PATH`,
  `PASSKEY_REGISTRATION_PATHS`, `PASSKEY_AUTHENTICATION_OPTIONS_PATH`, `PASSKEY_SIGN_IN_PATHS` —
  every one of them additive.
  
  **Patch on both counts the policy names.** Core migration `0010_session_passkey_enrolment`
  creates one table and alters nothing, so it is additive against N-1's readers and
  `migration-additivity.test.ts` passes. The reports change only additively as well: the new table is
  an added export, `hfSession`'s printed type is untouched, and `GRANT_RO_EXCLUDED_TABLES` — which
  the table joins, because a row of it names a session — is a const tuple that only grew, which the
  gate already excuses. A column on `hf_session` would not have been additive to `api-diff`: it
  reprints `hfSession.columns` and, through `AUTH_SCHEMA`, `AUTH_SCHEMA.session`, and both read as
  *retyped* members with no route through the gate. Issue #131 tracks that blind spot; the gate
  itself is unchanged by this release.
  
  An existing code session in a live database has no enrolment row and simply cannot promote until a
  fresh enrolment, which is the intended reading and needs no backfill. A session minted by passkey
  sign-in already holds `factor = 'passkey'` and never consults the table.
- Updated dependencies [5662f8d]
  - @hyperfixation/db@0.1.9

## 0.1.8

### Patch Changes

- Updated dependencies [7715754]
  - @hyperfixation/db@0.1.8

## 0.1.7

### Patch Changes

- Updated dependencies [ecd68f2]
- Updated dependencies [06695ea]
  - @hyperfixation/db@0.1.7

## 0.1.6

### Patch Changes

- @hyperfixation/db@0.1.6

## 0.1.5

### Patch Changes

- @hyperfixation/db@0.1.5

## 0.1.4

### Patch Changes

- @hyperfixation/db@0.1.4

## 0.1.3

### Patch Changes

- @hyperfixation/db@0.1.3

## 0.1.2

### Patch Changes

- 1c5152b: `evaluateAccess` reads `banExpires`, so a ban that has lapsed stops 404ing the user out of
  `/admin` and `/w`. Banned now means what the notifier's SQL already meant — `banned IS TRUE AND
  (ban_expires IS NULL OR ban_expires > now())` — and `AccessRequest.now` injects the clock.
- @hyperfixation/db@0.1.2

## 0.1.1

### Patch Changes

- `/api/status` now carries `llm.mode`, which `reportProvidersMode(pool)` writes at worker boot
  (migration 0008), and `hf doctor` warns when an app is serving fixture drafts. The CLI gained the
  cloud `hf new` path, `hf doctor` and `hf restore-check`, with the SSH runner and provisioning
  behind them; a child that exits before reading its stdin no longer fails a run with `EPIPE`, and
  `hf_score` names the spec it scored.
- Updated dependencies
  - @hyperfixation/db@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies
  - @hyperfixation/db@0.1.0
