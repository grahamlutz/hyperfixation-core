import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIGN_IN_PATH,
  DEFAULT_STEP_UP_PATH,
  evaluateAccess,
  routeAreaOf,
  type AccessDecision,
} from "./policy.js";
import { AccessRefused, createSessionGuard } from "./require-session.js";
import {
  EMAIL_OTP_SIGN_IN_PATH,
  PASSKEY_AUTHENTICATION_PATH,
  PASSKEY_REGISTRATION_PATH,
  hasRole,
  sessionFactorForPath,
  type AuthSession,
  type SessionFactor,
} from "./session.js";

const session = (factor: SessionFactor, role?: string | null): AuthSession => ({
  factor,
  user: { id: "u1", email: "member@app.test", role: role ?? null },
});

const CODE = session("code");
const PASSKEY = session("passkey");
const ADMIN = session("passkey", "admin");
const CODE_ADMIN = session("code", "admin");

describe("stamping a session's factor", () => {
  it("mints a passkey factor from the passkey authentication endpoint and nowhere else", () => {
    expect(sessionFactorForPath(PASSKEY_AUTHENTICATION_PATH)).toBe("passkey");
    expect(sessionFactorForPath(EMAIL_OTP_SIGN_IN_PATH)).toBe("code");
    // Enrolment is not authentication; promoting the session that enrolled is a separate,
    // deliberate step (`upgradeSessionFactor`), not a stamp.
    expect(sessionFactorForPath(PASSKEY_REGISTRATION_PATH)).toBe("code");
  });

  it("gives an unknown path the weaker factor", () => {
    expect(sessionFactorForPath("/sign-in/social")).toBe("code");
    expect(sessionFactorForPath("/some/plugin/added/later")).toBe("code");
    expect(sessionFactorForPath(undefined)).toBe("code");
    expect(sessionFactorForPath(null)).toBe("code");
  });
});

describe("reading a role out of the comma-separated column", () => {
  it("matches one entry of the list, whatever its spacing or case", () => {
    expect(hasRole({ id: "u1", role: "admin" }, "admin")).toBe(true);
    expect(hasRole({ id: "u1", role: "member,admin" }, "admin")).toBe(true);
    expect(hasRole({ id: "u1", role: " Admin , member " }, "admin")).toBe(true);
  });

  it("does not match a role that merely contains the one asked for", () => {
    expect(hasRole({ id: "u1", role: "administrator" }, "admin")).toBe(false);
    expect(hasRole({ id: "u1", role: "not-admin" }, "admin")).toBe(false);
    expect(hasRole({ id: "u1", role: null }, "admin")).toBe(false);
    expect(hasRole({ id: "u1", role: "" }, "admin")).toBe(false);
    expect(hasRole(null, "admin")).toBe(false);
  });
});

describe("the route areas", () => {
  it("reads the area off the first segment, api or not", () => {
    expect(routeAreaOf("/auth/sign-in")).toBe("auth");
    expect(routeAreaOf("/auth")).toBe("auth");
    expect(routeAreaOf("/api/auth/sign-in/email-otp")).toBe("auth");
    expect(routeAreaOf("/admin")).toBe("admin");
    expect(routeAreaOf("/admin/users/u1")).toBe("admin");
    expect(routeAreaOf("/api/admin/users")).toBe("admin");
    expect(routeAreaOf("/")).toBe("app");
    expect(routeAreaOf("/runs/abc")).toBe("app");
  });

  it("matches a whole segment, not a prefix", () => {
    expect(routeAreaOf("/administration")).toBe("app");
    expect(routeAreaOf("/authors/3")).toBe("app");
    expect(routeAreaOf("/runs/admin")).toBe("app");
  });
});

describe("what a session may reach", () => {
  it("lets a passkey session into the app, and either factor into the auth area", () => {
    expect(evaluateAccess({ session: PASSKEY, pathname: "/runs" })).toEqual({
      outcome: "allow",
      session: PASSKEY,
    });
    expect(evaluateAccess({ session: CODE, pathname: "/auth/passkey" }).outcome).toBe("allow");
    // A requirement is a minimum: the stronger factor satisfies `factor: 'code'`.
    expect(evaluateAccess({ session: PASSKEY, pathname: "/auth/passkey" }).outcome).toBe("allow");
    expect(evaluateAccess({ session: PASSKEY, factor: "code" }).outcome).toBe("allow");
  });

  it("lets an admin holding a passkey into the admin area", () => {
    expect(evaluateAccess({ session: ADMIN, pathname: "/admin/users" })).toEqual({
      outcome: "allow",
      session: ADMIN,
    });
    expect(evaluateAccess({ session: ADMIN, role: "admin" }).outcome).toBe("allow");
  });
});

describe("the auth negatives", () => {
  it("confines a code-factor session to the auth area", () => {
    for (const pathname of ["/", "/runs", "/api/runs", "/settings"]) {
      expect(evaluateAccess({ session: CODE, pathname })).toEqual({
        outcome: "redirect",
        to: DEFAULT_STEP_UP_PATH,
        refusal: "code-factor",
      });
    }
  });

  it("refuses a code-factor session in a server action that did not opt down", () => {
    // No pathname is the strict case: an action states its own bar, and the default is passkey.
    expect(evaluateAccess({ session: CODE })).toEqual({
      outcome: "redirect",
      to: DEFAULT_STEP_UP_PATH,
      refusal: "code-factor",
    });
    expect(evaluateAccess({ session: CODE, factor: "code" }).outcome).toBe("allow");
  });

  it("404s the admin area for a member rather than redirecting them", () => {
    expect(evaluateAccess({ session: PASSKEY, pathname: "/admin" })).toEqual({
      outcome: "not-found",
      refusal: "missing-role",
    });
    expect(evaluateAccess({ session: PASSKEY, pathname: "/api/admin/users" }).outcome).toBe(
      "not-found",
    );
    expect(evaluateAccess({ session: PASSKEY, role: "admin" }).outcome).toBe("not-found");
  });

  it("404s the admin area for nobody at all — a login redirect would say it is there", () => {
    const anonymous = evaluateAccess({ session: null, pathname: "/admin/users" });
    expect(anonymous).toEqual({ outcome: "not-found", refusal: "no-session" });
    // The same stranger anywhere else is sent to sign in, which is how we know the 404 is the
    // admin area's doing and not a blanket refusal.
    expect(evaluateAccess({ session: null, pathname: "/runs" })).toEqual({
      outcome: "redirect",
      to: DEFAULT_SIGN_IN_PATH,
      refusal: "no-session",
    });
  });

  it("404s an admin who only has a code-factor session, rather than offering a step-up", () => {
    // The role test runs first for exactly this: a step-up redirect here would confirm to
    // anyone holding an emailed code that the admin area exists.
    expect(evaluateAccess({ session: CODE_ADMIN, pathname: "/admin" })).toEqual({
      outcome: "not-found",
      refusal: "code-factor",
    });
  });

  it("refuses a banned user whose session is still alive", () => {
    const banned: AuthSession = { factor: "passkey", user: { id: "u9", role: "admin", banned: true } };
    expect(evaluateAccess({ session: banned, pathname: "/runs" })).toEqual({
      outcome: "redirect",
      to: DEFAULT_SIGN_IN_PATH,
      refusal: "banned",
    });
    expect(evaluateAccess({ session: banned, pathname: "/admin" })).toEqual({
      outcome: "not-found",
      refusal: "banned",
    });
  });
});

describe("requireSession", () => {
  const guard = (
    current: AuthSession | null,
    handlers: Partial<{
      onRedirect: (to: string, decision: AccessDecision) => void;
      onNotFound: (decision: AccessDecision) => void;
    }> = {},
  ) => createSessionGuard({ getSession: async () => current, ...handlers });

  it("returns the session it allowed", async () => {
    await expect(guard(ADMIN)({ role: "admin" })).resolves.toEqual(ADMIN);
  });

  it("diverts a refusal to the host's redirect and 404 handlers", async () => {
    const onRedirect = vi.fn(() => {
      throw new Error("redirected");
    });
    const onNotFound = vi.fn(() => {
      throw new Error("not found");
    });

    await expect(guard(CODE, { onRedirect, onNotFound })({ pathname: "/runs" })).rejects.toThrow(
      "redirected",
    );
    expect(onRedirect).toHaveBeenCalledWith(DEFAULT_STEP_UP_PATH, expect.anything());

    await expect(guard(PASSKEY, { onRedirect, onNotFound })({ pathname: "/admin" })).rejects.toThrow(
      "not found",
    );
    expect(onNotFound).toHaveBeenCalledOnce();
  });

  it("never returns a session a handler declined to divert", async () => {
    // Next's `redirect()`/`notFound()` throw, so this is unreachable there — it is what stops a
    // host that wires a non-throwing handler from being handed an unauthorized session.
    const onNotFound = vi.fn();
    await expect(
      guard(PASSKEY, { onNotFound })({ pathname: "/admin" }),
    ).rejects.toBeInstanceOf(AccessRefused);
    expect(onNotFound).toHaveBeenCalledOnce();
  });

  it("carries the decision on the error when nothing is wired at all", async () => {
    const error = await guard(null)({ pathname: "/runs" }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AccessRefused);
    expect((error as AccessRefused).decision).toEqual({
      outcome: "redirect",
      to: DEFAULT_SIGN_IN_PATH,
      refusal: "no-session",
    });
  });
});
