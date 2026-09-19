/** The one function every client talks to the network through; tests inject their own. */
export type FetchLike = typeof globalThis.fetch;

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ProviderRequest {
  method: HttpMethod;
  /** Path under the client's base URL, already interpolated. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/**
 * A provider answered with a status outside 2xx.
 *
 * The response body is on `body` and deliberately **not** in `message`: a Coolify 422 echoes
 * the fields it rejected, and those fields are the app's whole environment — its database URL,
 * its status tokens, its Langfuse secret key. `hf` prints `error.message`, so a body that
 * quotes a secret would land in a terminal and a scrollback. Nor is the query string included,
 * for the same reason.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly method: HttpMethod;
  readonly path: string;
  readonly body: string;

  constructor(provider: string, request: ProviderRequest, status: number, body: string) {
    super(`${provider} ${request.method} ${request.path} failed: HTTP ${status}`);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.method = request.method;
    this.path = request.path;
    this.body = body;
  }
}

export interface TransportOptions {
  /** Names the provider in errors. */
  provider: string;
  /** Everything before `path`, including any API prefix (`https://coolify.example/api/v1`). */
  baseUrl: string;
  /** Sent on every request — the authorization header, and whatever else the API insists on. */
  headers: Record<string, string>;
  fetch?: FetchLike;
}

export type Transport = <Result>(request: ProviderRequest) => Promise<Result>;

/** Builds the `request` function the clients in this directory are written against. */
export function createTransport(options: TransportOptions): Transport {
  // Looked up per request, not captured: a test's mock server replaces `globalThis.fetch` after
  // the clients have been constructed.
  const doFetch: FetchLike = (input, init) => (options.fetch ?? globalThis.fetch)(input, init);
  const base = options.baseUrl.replace(/\/+$/, "");

  return async <Result>(request: ProviderRequest): Promise<Result> => {
    const url = new URL(base + request.path);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }

    const headers: Record<string, string> = { accept: "application/json", ...options.headers };
    if (request.body !== undefined) headers["content-type"] = "application/json";

    const response = await doFetch(url, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new ProviderError(options.provider, request, response.status, text);
    }
    return (text === "" ? undefined : JSON.parse(text)) as Result;
  };
}

/** Percent-encodes one path segment, so an app name can never escape into the path. */
export function segment(value: string): string {
  return encodeURIComponent(value);
}
