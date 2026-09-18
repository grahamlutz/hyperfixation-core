import type { Pool } from "pg";
import { bearerToken, statusTokenMatches } from "./status-token.js";
import type { StatusOptions, StatusReport } from "./status.js";

/** The three routes, relative to wherever the app mounts them. */
export type StatusRoute = "status" | "pause" | "resume";

/** `hf_app_state.paused_by` and the audit row's actor when the write token did it. */
export const STATUS_TOKEN_ACTOR = "status-token";

const TOKEN_HASHES_STATEMENT =
  "SELECT read_token_hash, write_token_hash FROM hf_app_state WHERE id = 1";

export interface StatusRouteHandlers {
  status(): Promise<StatusReport>;
  pause(): Promise<unknown>;
  resume(): Promise<unknown>;
}

export interface StatusHandlerOptions extends StatusOptions {
  pool: Pool;
  handlers: StatusRouteHandlers;
}

/**
 * Matched on the suffix rather than on a fixed prefix: the app owns where it mounts these, and
 * the template's `app/api/status/route.ts` is only the default.
 */
export function statusRouteOf(pathname: string): StatusRoute | undefined {
  const trimmed = pathname.replace(/\/+$/, "");
  if (trimmed.endsWith("/status")) return "status";
  if (trimmed.endsWith("/status/pause")) return "pause";
  if (trimmed.endsWith("/status/resume")) return "resume";
  return undefined;
}

/**
 * `GET /api/status` under the read token; `POST /api/status/pause` and `/resume` under the
 * write token. A write token reads too — it is strictly the more privileged of the two, and a
 * deploy check that had to carry both would be two secrets where one will do.
 *
 * Every refusal answers the same way whether the token was wrong, missing or unconfigured, and
 * the comparison itself is `timingSafeEqual` against the stored hash.
 */
export function createStatusHandler(
  options: StatusHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const route = statusRouteOf(new URL(request.url).pathname);
    if (route === undefined) return json({ error: "not found" }, 404);

    const method = route === "status" ? "GET" : "POST";
    if (request.method !== method) {
      return json({ error: `${route} is ${method}` }, 405, { allow: method });
    }

    if (!(await authorized(options.pool, request, route))) {
      return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
    }

    if (route === "status") return json(await options.handlers.status(), 200);
    const result = route === "pause" ? await options.handlers.pause() : await options.handlers.resume();
    return json(result as Record<string, unknown>, 200);
  };
}

async function authorized(pool: Pool, request: Request, route: StatusRoute): Promise<boolean> {
  const presented = bearerToken(request);
  const { rows } = await pool.query<{
    read_token_hash: string | null;
    write_token_hash: string | null;
  }>(TOKEN_HASHES_STATEMENT);
  const hashes = rows[0];

  // Both comparisons run on a read so that a valid read token and a valid write token take the
  // same path; neither short-circuits on the other's result.
  const write = statusTokenMatches(presented, hashes?.write_token_hash);
  if (route !== "status") return write;
  return statusTokenMatches(presented, hashes?.read_token_hash) || write;
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}
