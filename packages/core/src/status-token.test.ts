import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bearerToken, hashStatusToken, statusTokenMatches } from "./status-token.js";
import { statusRouteOf } from "./status-route.js";

const TOKEN = "s3cret-read-token";
const HASH = createHash("sha256").update(TOKEN, "utf8").digest("hex");

describe("status tokens", () => {
  it("stores a token as its sha-256 digest", () => {
    expect(hashStatusToken(TOKEN)).toBe(HASH);
    expect(hashStatusToken(TOKEN)).toHaveLength(64);
  });

  it("matches the token its hash was made from and nothing else", () => {
    expect(statusTokenMatches(TOKEN, HASH)).toBe(true);
    expect(statusTokenMatches(`${TOKEN}x`, HASH)).toBe(false);
    expect(statusTokenMatches(TOKEN.slice(0, -1), HASH)).toBe(false);
    // A token of a wildly different length is the case `timingSafeEqual` throws on unhashed.
    expect(statusTokenMatches("x", HASH)).toBe(false);
    expect(statusTokenMatches("x".repeat(4096), HASH)).toBe(false);
  });

  it("refuses rather than opens when there is nothing to match against", () => {
    expect(statusTokenMatches(TOKEN, null)).toBe(false);
    expect(statusTokenMatches(TOKEN, undefined)).toBe(false);
    expect(statusTokenMatches(null, HASH)).toBe(false);
    expect(statusTokenMatches("", HASH)).toBe(false);
    expect(statusTokenMatches("", null)).toBe(false);
  });

  it("refuses a stored hash that is not a sha-256 digest", () => {
    expect(statusTokenMatches(TOKEN, "not-hex")).toBe(false);
    expect(statusTokenMatches(TOKEN, HASH.slice(0, 40))).toBe(false);
    expect(statusTokenMatches(TOKEN, `${HASH}00`)).toBe(false);
  });

  it("reads the token from an Authorization: Bearer header only", () => {
    const withHeader = (headers: Record<string, string>): Request =>
      new Request("https://app.test/api/status", { headers });

    expect(bearerToken(withHeader({ authorization: `Bearer ${TOKEN}` }))).toBe(TOKEN);
    expect(bearerToken(withHeader({ authorization: `bearer ${TOKEN}` }))).toBe(TOKEN);
    expect(bearerToken(withHeader({ authorization: TOKEN }))).toBeNull();
    expect(bearerToken(withHeader({ "x-hf-token": TOKEN }))).toBeNull();
    expect(bearerToken(withHeader({}))).toBeNull();
  });
});

describe("the status routes", () => {
  it("matches on the suffix, so the app owns where it mounts them", () => {
    expect(statusRouteOf("/api/status")).toBe("status");
    expect(statusRouteOf("/api/status/")).toBe("status");
    expect(statusRouteOf("/api/status/pause")).toBe("pause");
    expect(statusRouteOf("/internal/ops/status/resume")).toBe("resume");
    expect(statusRouteOf("/api/status/other")).toBeUndefined();
    expect(statusRouteOf("/api/health")).toBeUndefined();
  });
});
