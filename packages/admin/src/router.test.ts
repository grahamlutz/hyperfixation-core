import {
  AccessRefused,
  createSessionGuard,
  type AuthSession,
  type SessionFactor,
} from "@hyperfixation/auth";
import { DuplicateRegistration } from "@hyperfixation/core";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { resourceFromTable } from "./resource.js";
import { ADMIN_BASE_PATH, createAdminRouter } from "./router.js";
import { usersResource } from "./users.js";
import { hfSession } from "@hyperfixation/db";

/** Never connected: `route()` resolves a path and never reaches the database. */
const pool = new Pool({ connectionString: "postgresql://unused/unused" });

afterAll(async () => {
  await pool.end();
});

const session = (factor: SessionFactor, role: string | null): AuthSession => ({
  factor,
  user: { id: "u1", email: "who@app.test", role },
});

interface Host {
  requireSession: ReturnType<typeof createSessionGuard>;
  notFound: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
}

const hostFor = (current: AuthSession | null): Host => {
  const notFound = vi.fn();
  const redirect = vi.fn();
  return {
    notFound,
    redirect,
    requireSession: createSessionGuard({
      getSession: () => Promise.resolve(current),
      onNotFound: notFound,
      onRedirect: redirect,
    }),
  };
};

const routerFor = (current: AuthSession | null) => {
  const host = hostFor(current);
  return { host, router: createAdminRouter({ pool, requireSession: host.requireSession }) };
};

describe("what the admin router resolves for an admin", () => {
  const { router } = routerFor(session("passkey", "admin"));

  it("resolves the mount point itself to the resource index", async () => {
    await expect(router.route([])).resolves.toEqual({ kind: "index" });
    await expect(router.route("/admin")).resolves.toEqual({ kind: "index" });
  });

  it("resolves a registered resource to its list", async () => {
    await expect(router.route(["users"])).resolves.toEqual({
      kind: "list",
      resource: usersResource,
    });
  });

  it("resolves a second segment to one row", async () => {
    await expect(router.route(["users", "u-lost"])).resolves.toEqual({
      kind: "detail",
      resource: usersResource,
      id: "u-lost",
    });
  });

  it("resolves nothing for an unregistered resource or a path too deep", async () => {
    await expect(router.route(["widgets"])).resolves.toBeUndefined();
    await expect(router.route(["users", "u-lost", "edit"])).resolves.toBeUndefined();
  });
});

describe("the guard at the admin router's entry point", () => {
  it("refuses a member holding a passkey with not-found, and resolves nothing", async () => {
    const { host, router } = routerFor(session("passkey", "member"));

    await expect(router.route(["users"])).rejects.toBeInstanceOf(AccessRefused);
    expect(host.notFound).toHaveBeenCalledTimes(1);
    expect(host.redirect).not.toHaveBeenCalled();
    expect(host.notFound.mock.calls[0]?.[0]).toMatchObject({
      outcome: "not-found",
      refusal: "missing-role",
    });
  });

  it("refuses a stranger with not-found rather than a sign-in redirect", async () => {
    const { host, router } = routerFor(null);

    await expect(router.route([])).rejects.toBeInstanceOf(AccessRefused);
    expect(host.notFound).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "not-found", refusal: "no-session" }),
    );
    expect(host.redirect).not.toHaveBeenCalled();
  });

  it("refuses an admin who only has an emailed code, with the same 404", async () => {
    // A step-up redirect here would confirm the admin area to anyone who can read an inbox.
    const { host, router } = routerFor(session("code", "admin"));

    await expect(router.route(["users"])).rejects.toBeInstanceOf(AccessRefused);
    expect(host.notFound).toHaveBeenCalledTimes(1);
    expect(host.redirect).not.toHaveBeenCalled();
  });

  it("refuses a banned admin", async () => {
    const banned: AuthSession = {
      factor: "passkey",
      user: { id: "u1", role: "admin", banned: true },
    };
    const { host, router } = routerFor(banned);

    await expect(router.route(["users"])).rejects.toBeInstanceOf(AccessRefused);
    expect(host.notFound).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "not-found", refusal: "banned" }),
    );
  });

  it("runs the guard before it decides whether the path exists", async () => {
    // Otherwise `/admin/widgets` and `/admin/users` answer differently to a stranger, and the
    // difference is a map of the admin area.
    const { host, router } = routerFor(session("passkey", "member"));

    await expect(router.route(["widgets"])).rejects.toBeInstanceOf(AccessRefused);
    expect(host.notFound).toHaveBeenCalledTimes(1);
  });

  it("asks for the route it is about to serve, so the refusal is the admin area's", async () => {
    const seen: unknown[] = [];
    const router = createAdminRouter({
      pool,
      requireSession: (required) => {
        seen.push(required);
        return Promise.resolve(session("passkey", "admin"));
      },
    });

    await router.route(["users", "u-lost"]);
    expect(seen).toEqual([
      { factor: "passkey", role: "admin", pathname: `${ADMIN_BASE_PATH}/users/u-lost` },
    ]);
  });
});

describe("the resources the router holds", () => {
  it("registers users, and whatever else the app hands it", async () => {
    const sessions = resourceFromTable(hfSession, { name: "sessions", list: ["token"] });
    const host = hostFor(session("passkey", "admin"));
    const router = createAdminRouter({
      pool,
      requireSession: host.requireSession,
      resources: [sessions],
    });

    expect(router.resources.names()).toEqual(["users", "sessions"]);
    await expect(router.route(["sessions"])).resolves.toEqual({
      kind: "list",
      resource: sessions,
    });
  });

  it("refuses a second resource under a name it already holds", () => {
    const host = hostFor(session("passkey", "admin"));
    const shadow = resourceFromTable(hfSession, { name: "users", list: ["token"] });

    expect(() =>
      createAdminRouter({ pool, requireSession: host.requireSession, resources: [shadow] }),
    ).toThrow(DuplicateRegistration);
  });
});
