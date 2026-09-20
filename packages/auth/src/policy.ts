import type { AuthSession, SessionFactor, SessionUser } from "./session.js";
import { hasRole } from "./session.js";

/** Where a code-factor session is allowed to be, and where an unauthenticated one is sent. */
export const AUTH_AREA = "auth";
/** The area that does not exist for anyone who cannot enter it. */
export const ADMIN_AREA = "admin";

export const DEFAULT_SIGN_IN_PATH = "/auth/sign-in";
export const DEFAULT_STEP_UP_PATH = "/auth/passkey";

/** The role `/admin/*` requires, and the one `bootstrapAdmin` grants. */
export const ADMIN_ROLE = "admin";

export type RouteArea = "auth" | "admin" | "app";

export type AccessRefusal = "no-session" | "banned" | "code-factor" | "missing-role";

export type AccessDecision =
  | { outcome: "allow"; session: AuthSession }
  | { outcome: "redirect"; to: string; refusal: AccessRefusal }
  | { outcome: "not-found"; refusal: AccessRefusal };

export interface AccessPaths {
  signInPath?: string;
  stepUpPath?: string;
}

export interface AccessRequest extends AccessPaths {
  session: AuthSession | null | undefined;
  /**
   * The route being entered. A layout or route handler knows it; a server action does not, and
   * omitting it is the strict case — see `evaluateAccess`.
   */
  pathname?: string;
  /** Raise the bar above what the route alone demands. Never lowers `/admin/*`. */
  factor?: SessionFactor;
  role?: string;
  /** The clock the ban expiry is read against. Injectable so a test can sit on an instant. */
  now?: () => number;
}

/**
 * The same rule the notifier's SQL applies — `banned IS TRUE AND (ban_expires IS NULL OR
 * ban_expires > now())`. A ban with a lapsed expiry is over even though the column still says
 * `true`: nothing sweeps the row, so the expiry is what decides. An unreadable `ban_expires`
 * keeps the ban, because the alternative is letting a bad value un-ban someone.
 */
function banIsActive(user: SessionUser, now: number): boolean {
  if (user.banned !== true) return false;
  const expires = user.banExpires;
  if (expires === null || expires === undefined) return true;
  const at = expires instanceof Date ? expires.getTime() : Date.parse(expires);
  return Number.isNaN(at) || at > now;
}

/**
 * The first segment, with a leading `/api` stripped, so `/api/admin/users` is admin territory
 * to a route handler exactly as `/admin/users` is to a layout. Stripping `/api` is also what
 * keeps `/api/auth/*` — better-auth's own handler, which a code-factor session must be able to
 * drive in order to enrol a passkey at all — inside the auth area.
 */
export function routeAreaOf(pathname: string): RouteArea {
  const path = pathname.split("?")[0]!.split("#")[0]!;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const first = (segments[0] === "api" ? segments.slice(1) : segments)[0];
  if (first === AUTH_AREA) return "auth";
  if (first === ADMIN_AREA) return "admin";
  return "app";
}

/**
 * The session-factor policy, as one pure function over a fake-able session.
 *
 * Three rules, and the order between them is the point:
 *
 * 1. A check that names a role — every `/admin/*` route, and any action that asks for one —
 *    answers **404 for every refusal**, including "not signed in at all". A redirect would say
 *    that the path exists and that signing in is worth trying; the whole reason `/admin/*`
 *    404s rather than redirects is that it must not say so. So the role test runs before the
 *    factor test: an admin holding only a code-factor session gets the same 404 as a stranger,
 *    not a step-up redirect that would confirm the area.
 * 2. A code-factor session is confined to the auth area. Everywhere else it is refused and sent
 *    to step up, because it is one factor — possession of an inbox — and nothing more.
 * 3. Requirements are minimums. A passkey session satisfies `factor: 'code'`; the reverse is
 *    what rule 2 refuses.
 *
 * `pathname` omitted means "app area", the strict case: a server action states its own bar, and
 * one that carries no `factor` is passkey-only. An action reachable from `/auth/*` — sending a
 * code, enrolling the first passkey — opts down with `factor: 'code'` explicitly.
 */
export function evaluateAccess(request: AccessRequest): AccessDecision {
  const area = request.pathname === undefined ? "app" : routeAreaOf(request.pathname);
  const requiredRole = request.role ?? (area === "admin" ? ADMIN_ROLE : undefined);
  const requiredFactor: SessionFactor = request.factor ?? (area === "auth" ? "code" : "passkey");
  const hidden = requiredRole !== undefined;

  const signIn = request.signInPath ?? DEFAULT_SIGN_IN_PATH;
  const stepUp = request.stepUpPath ?? DEFAULT_STEP_UP_PATH;
  const refuse = (refusal: AccessRefusal, to: string): AccessDecision =>
    hidden ? { outcome: "not-found", refusal } : { outcome: "redirect", to, refusal };

  const { session } = request;
  if (!session) return refuse("no-session", signIn);
  // A ban lands on the user row while their sessions are still live; it has to be read here or
  // a banned admin keeps the tab they already had open.
  if (banIsActive(session.user, (request.now ?? Date.now)())) return refuse("banned", signIn);

  if (requiredRole !== undefined && !hasRole(session.user, requiredRole)) {
    return { outcome: "not-found", refusal: "missing-role" };
  }

  if (requiredFactor === "passkey" && session.factor !== "passkey") {
    return refuse("code-factor", stepUp);
  }

  return { outcome: "allow", session };
}
