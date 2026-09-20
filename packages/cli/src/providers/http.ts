import { redactPasswords } from "../database.js";

/** The one function every client talks to the network through; tests inject their own. */
export type FetchLike = typeof globalThis.fetch;

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ProviderRequest {
  method: HttpMethod;
  /** Path under the client's base URL, already interpolated. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Values this request carries that a provider may echo back at it — the app's environment, in
   * the one call that sends it. Blanked out of the error message; see `explain`.
   */
  secrets?: readonly string[];
}

/** How much of a rejected request's explanation reaches the message before it is cut. */
export const EXPLANATION_LIMIT = 500;

/**
 * A provider answered with a status outside 2xx.
 *
 * `message` carries the response's own `message` and `errors` and nothing else of it: those two are
 * where every provider here puts the reason, and the rest of a body is free to quote what was sent.
 * What reaches the message is redacted first — every credential the client was built with, every
 * value the request declared, and anything shaped like a password — because `hf` prints
 * `error.message` and a terminal keeps a scrollback. The raw body is on `body` for a caller that
 * wants it; the request's own headers and query string are in neither.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly method: HttpMethod;
  readonly path: string;
  readonly body: string;

  constructor(
    provider: string,
    request: ProviderRequest,
    status: number,
    body: string,
    explanation?: string,
  ) {
    super(
      `${provider} ${request.method} ${request.path} failed: HTTP ${status}` +
        (explanation === undefined ? "" : `: ${explanation}`),
    );
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
  /** The credentials this client was built with; blanked out of every error message. */
  secrets?: readonly string[];
  fetch?: FetchLike;
}

/**
 * Why the provider refused, out of its `message` and `errors` and redacted.
 *
 * `undefined` when the body is not JSON or carries neither key: a provider that explained nothing
 * leaves the status to speak, rather than a page of HTML in a terminal.
 */
export function explain(body: string, secrets: readonly string[]): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;

  const { message, errors } = parsed as { message?: unknown; errors?: unknown };
  if (message === undefined && errors === undefined) return undefined;

  let text = JSON.stringify({
    ...(message === undefined ? {} : { message }),
    ...(errors === undefined ? {} : { errors }),
  });
  for (const secret of secrets) {
    // Short values are skipped: a two-character secret would blank half the explanation with it.
    if (secret.length < 4) continue;
    text = text.split(JSON.stringify(secret).slice(1, -1)).join("***");
  }
  text = redactPasswords(text);
  return text.length > EXPLANATION_LIMIT ? `${text.slice(0, EXPLANATION_LIMIT)}…` : text;
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
      const secrets = [...(options.secrets ?? []), ...(request.secrets ?? [])];
      throw new ProviderError(
        options.provider,
        request,
        response.status,
        text,
        explain(text, secrets),
      );
    }
    return (text === "" ? undefined : JSON.parse(text)) as Result;
  };
}

/** Percent-encodes one path segment, so an app name can never escape into the path. */
export function segment(value: string): string {
  return encodeURIComponent(value);
}
