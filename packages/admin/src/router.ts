import {
  ADMIN_ROLE,
  createResetSecondFactorAction,
  type RequireSession,
  type ResetSecondFactorAction,
} from "@hyperfixation/auth";
import { createRegistry, type Registry } from "@hyperfixation/core";
import type { Pool } from "pg";
import type { AdminResource } from "./resource.js";
import { usersResource } from "./users.js";

/** Where the template mounts the admin. Only the default; `route()` takes what it is given. */
export const ADMIN_BASE_PATH = "/admin";

export type AdminRoute =
  | { kind: "index" }
  | { kind: "list"; resource: AdminResource }
  | { kind: "detail"; resource: AdminResource; id: string };

/** The admin's server actions. Each one carries its own guard. */
export interface AdminActions {
  resetSecondFactor: ResetSecondFactorAction;
}

export interface AdminRouterOptions {
  /** The app's own pool. The admin builds none and runs on the web request path. */
  pool: Pool;
  requireSession: RequireSession;
  /** Resources beyond `users`. Phase 1 registers none; Phase 2's machinery tables will. */
  resources?: readonly AdminResource[];
}

export interface AdminRouter {
  readonly resources: Registry<AdminResource>;
  readonly actions: AdminActions;
  /**
   * The catch-all's body: the segments below the mount point, guarded and resolved. `undefined`
   * is a path the admin does not serve — the host renders its own not-found for it, the same
   * one a refusal produces.
   */
  route(path?: string | readonly string[]): Promise<AdminRoute | undefined>;
}

function segmentsOf(path: string | readonly string[] | undefined): string[] {
  // A catch-all already hands back the segments below the mount, so an array is taken as-is —
  // a resource named `admin` stays reachable. Only a whole pathname has the mount on the front.
  if (typeof path !== "string") return (path ?? []).filter((segment) => segment.length > 0);
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments[0] === ADMIN_BASE_PATH.slice(1) ? segments.slice(1) : segments;
}

/**
 * The admin, as one guarded entry point the app's `(admin)/admin/[[...path]]` route calls.
 *
 * The guard runs before the path is resolved, and it runs on every route including the index.
 * Resolving first would let `/admin/widgets` and `/admin/users` answer a stranger differently,
 * and the difference between those two answers is a map of the admin area — the thing the 404
 * exists to withhold. `requireSession({ factor: 'passkey', role: 'admin' })` is stated here
 * rather than left to the route's own `pathname`, so a host that mounts the admin somewhere
 * else still gets the admin bar.
 */
export function createAdminRouter(options: AdminRouterOptions): AdminRouter {
  const resources = createRegistry<AdminResource>("admin resource");
  resources.register(usersResource);
  for (const resource of options.resources ?? []) resources.register(resource);

  return {
    resources,
    actions: {
      resetSecondFactor: createResetSecondFactorAction({
        pool: options.pool,
        requireSession: options.requireSession,
      }),
    },
    async route(path?: string | readonly string[]): Promise<AdminRoute | undefined> {
      const segments = segmentsOf(path);
      await options.requireSession({
        factor: "passkey",
        role: ADMIN_ROLE,
        pathname: [ADMIN_BASE_PATH, ...segments].join("/"),
      });

      if (segments.length === 0) return { kind: "index" };
      if (segments.length > 2) return undefined;

      const resource = resources.get(segments[0]!);
      if (resource === undefined) return undefined;
      const id = segments[1];
      return id === undefined ? { kind: "list", resource } : { kind: "detail", resource, id };
    },
  };
}
