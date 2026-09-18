import { createHash, timingSafeEqual } from "node:crypto";

/** What `hf_app_state.read_token_hash` and `write_token_hash` hold. */
export const STATUS_TOKEN_DIGEST = "sha256";
const DIGEST_BYTES = 32;

/**
 * The stored form of a status token. Hashing is not only about the database: it also makes the
 * comparison fixed-width, which is what lets `timingSafeEqual` — which throws on a length
 * mismatch — be used on a value an attacker chooses the length of.
 */
export function hashStatusToken(token: string): string {
  return createHash(STATUS_TOKEN_DIGEST).update(token, "utf8").digest("hex");
}

/**
 * Constant-time against the stored hash. Every "no" that is not about the bytes — no token
 * presented, no hash configured, a hash that is not a `sha256` digest — is answered before the
 * comparison and is not timing-sensitive: none of them depends on the presented token.
 *
 * An app with no hash configured is refused rather than opened: an unset token is a
 * misconfiguration, and the status endpoint can pause the app.
 */
export function statusTokenMatches(
  presented: string | null | undefined,
  storedHash: string | null | undefined,
): boolean {
  if (presented === null || presented === undefined || presented === "") return false;
  if (storedHash === null || storedHash === undefined) return false;

  const stored = Buffer.from(storedHash, "hex");
  // `Buffer.from` truncates at the first non-hex character rather than throwing, so a mangled
  // hash arrives here short; nothing of digest length can be produced that way by accident.
  if (stored.length !== DIGEST_BYTES) return false;

  return timingSafeEqual(
    createHash(STATUS_TOKEN_DIGEST).update(presented, "utf8").digest(),
    stored,
  );
}

/** `Authorization: Bearer <token>`, and nothing else — a token in a query string is logged. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  return match === null ? null : match[1]!;
}
