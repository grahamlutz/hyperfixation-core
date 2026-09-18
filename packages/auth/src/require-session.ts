import {
  evaluateAccess,
  type AccessDecision,
  type AccessPaths,
  type AccessRequest,
} from "./policy.js";
import type { AuthSession } from "./session.js";

/**
 * What a refusal throws when the host's handler returns instead of diverting. Next's
 * `redirect()` and `notFound()` both throw, so in the template this is unreachable — it exists
 * so that `requireSession` cannot return an unauthorized session under a handler that forgets.
 */
export class AccessRefused extends Error {
  readonly decision: AccessDecision;

  constructor(decision: AccessDecision) {
    super(
      decision.outcome === "not-found"
        ? `access refused (${decision.refusal}): not found`
        : decision.outcome === "redirect"
          ? `access refused (${decision.refusal}): redirect to ${decision.to}`
          : "access refused",
    );
    this.name = "AccessRefused";
    this.decision = decision;
  }
}

export interface SessionGuardOptions extends AccessPaths {
  /**
   * Reads the session for the current request. In Next this is
   * `auth.api.getSession({ headers: await headers() })`; in a test it is a fake.
   */
  getSession: () => Promise<AuthSession | null | undefined>;
  /** `redirect(to)` in Next. Expected to throw; if it returns, `AccessRefused` is thrown. */
  onRedirect?: (to: string, decision: AccessDecision) => void | Promise<void>;
  /** `notFound()` in Next. Same contract. */
  onNotFound?: (decision: AccessDecision) => void | Promise<void>;
}

export interface RequireSessionOptions {
  factor?: AccessRequest["factor"];
  role?: AccessRequest["role"];
  /** The route being entered. Omitted in a server action — see `evaluateAccess`. */
  pathname?: string;
}

export type RequireSession = (options?: RequireSessionOptions) => Promise<AuthSession>;

/**
 * `requireSession({ factor, role })` for layouts, server actions and route handlers, bound once
 * per app to a session reader and to whatever this host diverts with.
 */
export function createSessionGuard(options: SessionGuardOptions): RequireSession {
  return async (required: RequireSessionOptions = {}): Promise<AuthSession> => {
    const session = await options.getSession();
    const decision = evaluateAccess({
      session,
      pathname: required.pathname,
      factor: required.factor,
      role: required.role,
      signInPath: options.signInPath,
      stepUpPath: options.stepUpPath,
    });

    if (decision.outcome === "allow") return decision.session;

    if (decision.outcome === "redirect") await options.onRedirect?.(decision.to, decision);
    else await options.onNotFound?.(decision);

    throw new AccessRefused(decision);
  };
}
