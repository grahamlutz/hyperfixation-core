/**
 * `https://x-access-token:<token>@github.com/owner/repo.git` — the shape a clone URL used to
 * carry, and the one an old checkout or a hand-run command still can.
 */
const URL_CREDENTIAL = /\/\/[^/\s@]*:[^/\s@]*@/gu;

/** `AUTHORIZATION: basic <base64>`, whether it arrived as a header or as `http.extraheader=`. */
const AUTH_HEADER = /(authorization\s*:\s*(?:basic|bearer)\s+)\S+/giu;

/**
 * Below this an environment value is a flag, a port or a username, and blanking every occurrence
 * of it would mangle the message instead of protecting anything.
 */
const MIN_SECRET_LENGTH = 8;

const SECRET_NAME = /token|secret|password|auth|private[_-]?key/iu;

/**
 * Every environment value that is plausibly a credential: `GITHUB_TOKEN`, the bot App's
 * installation tokens, `npm_config_//registry.npmjs.org/:_authToken`. Over-matching is the safe
 * direction — a redacted value that was not a secret costs nothing.
 */
export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_SECRET_LENGTH) continue;
    if (SECRET_NAME.test(name)) values.add(value);
  }
  // Longest first, so a token that contains another value is not left half-replaced.
  return [...values].sort((a, b) => b.length - a.length);
}

let processSecrets: string[] | undefined;

/**
 * The last thing every message passes through before it becomes a `ReleaseError` or a log line.
 * An `SMTP_URL` token reached a log in X1; the release tooling hands git and `gh` credentials on
 * the command line, and argv is what these messages quote.
 */
export function redact(text: string, secrets?: readonly string[]): string {
  processSecrets ??= secretValues();
  let out = text.replace(URL_CREDENTIAL, "//***@").replace(AUTH_HEADER, "$1***");
  for (const secret of secrets ?? processSecrets) out = out.split(secret).join("***");
  return out;
}
