import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { http, HttpResponse, type RequestHandler } from "msw";
import { setupServer } from "msw/node";
import validatorModule from "openapi-request-validator";

type ValidatorConstructor = typeof validatorModule.default;
type ValidatorArgs = ConstructorParameters<ValidatorConstructor>[0];

// A CommonJS package with an `export default`: Node's own interop hands back the module object,
// with the class under `.default`, while Vite unwraps it. Either arrives here.
const OpenAPIRequestValidator =
  (validatorModule as unknown as { default?: ValidatorConstructor }).default ??
  (validatorModule as unknown as ValidatorConstructor);

type MswServer = ReturnType<typeof setupServer>;

/** The vendored documents under `packages/cli/openapi/`, by file name. */
export type SpecName = "coolify" | "cloudflare" | "github" | "sentry" | "langfuse";

const OPENAPI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "openapi");

interface OpenApiDocument {
  servers?: { url: string }[];
  paths: Record<string, Record<string, OpenApiOperation> & { parameters?: unknown[] }>;
  components?: Record<string, Record<string, unknown>>;
}

interface OpenApiOperation {
  operationId?: string;
  parameters?: unknown[];
  requestBody?: unknown;
}

const documents = new Map<SpecName, OpenApiDocument>();

function openApiDocument(spec: SpecName): OpenApiDocument {
  let document = documents.get(spec);
  if (document === undefined) {
    document = JSON.parse(
      readFileSync(path.join(OPENAPI_DIR, `${spec}.json`), "utf8"),
    ) as OpenApiDocument;
    documents.set(spec, document);
  }
  return document;
}

export interface StubRoute {
  /** The document the request is validated against. */
  spec: SpecName;
  /** The verb the handler answers — not necessarily one the document allows. */
  method: "get" | "post" | "patch" | "put" | "delete";
  /**
   * The URL the client will call, with OpenAPI-style `{placeholders}` — e.g.
   * `https://coolify.test/api/v1/projects/{uuid}`.
   */
  url: string;
  status?: number;
  json?: unknown;
  /** Answers one request and then steps aside — a lookup that 404s before a create, say. */
  once?: boolean;
}

export interface RecordedRequest {
  spec: SpecName;
  method: string;
  /** The path as the document spells it, e.g. `/applications/{uuid}/envs/bulk`. */
  operationPath: string;
  pathname: string;
  query: Record<string, string>;
  body: unknown;
}

export interface OpenApiHarness {
  readonly server: MswServer;
  /** Every request that reached a handler, in order. */
  readonly requests: readonly RecordedRequest[];
  /** One more validating handler, for `server.use` — a per-test response or a bad fixture. */
  handler(route: StubRoute): RequestHandler;
  /** The violations so far, cleared: a test that expects one takes it rather than failing on it. */
  takeViolations(): string[];
  reset(): void;
}

/**
 * An msw server whose handlers refuse any request the vendored OpenAPI document does not
 * describe — wrong verb, unknown path, unknown query parameter, body that does not validate.
 *
 * The point is that a client method is only "green" when the request it issues is one the
 * provider's own published document accepts, so drift shows up here rather than half way
 * through provisioning a real app. A violation both fails the request (the client sees a 500
 * whose body carries the reason) and is collected for `takeViolations`, so it cannot be
 * swallowed by a caller that tolerates an error.
 */
export function createOpenApiHarness(routes: readonly StubRoute[]): OpenApiHarness {
  const requests: RecordedRequest[] = [];
  const violations: string[] = [];

  const handler = (route: StubRoute): RequestHandler =>
    http[route.method](
      toMswPath(route.url),
      async ({ request }) => {
        const url = new URL(request.url);
        const body = await readJsonBody(request);
        const problem = validate(route.spec, request.method, url, body, requests);
        if (problem !== undefined) {
          violations.push(problem);
          return HttpResponse.json({ openApiViolation: problem }, { status: 500 });
        }
        return HttpResponse.json(route.json ?? {}, { status: route.status ?? 200 });
      },
      { once: route.once ?? false },
    );

  const server = setupServer(...routes.map(handler));

  return {
    server,
    requests,
    handler,
    takeViolations() {
      return violations.splice(0, violations.length);
    },
    reset() {
      requests.length = 0;
      violations.length = 0;
    },
  };
}

function validate(
  spec: SpecName,
  method: string,
  url: URL,
  body: unknown,
  requests: RecordedRequest[],
): string | undefined {
  const document = openApiDocument(spec);
  // Not `new URL(...).pathname`: Sentry's server url templates its *host* (`https://{region}.…`).
  const basePath = (document.servers?.[0]?.url ?? "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "")
    .replace(/\/+$/, "");
  if (!url.pathname.startsWith(basePath)) {
    return `${spec}: ${method} ${url.pathname} is not under the document's server path ${basePath}`;
  }
  const relative = url.pathname.slice(basePath.length);

  const match = findOperation(document, method, relative);
  if (match === undefined) {
    return `${spec}: no ${method} operation for ${relative}`;
  }

  const query = Object.fromEntries(url.searchParams);
  requests.push({
    spec,
    method,
    operationPath: match.operationPath,
    pathname: url.pathname,
    query,
    body,
  });

  const parameters = dereference(document, [
    ...(document.paths[match.operationPath]!.parameters ?? []),
    ...(match.operation.parameters ?? []),
  ]);

  const validator = new OpenAPIRequestValidator({
    parameters,
    requestBody:
      match.operation.requestBody === undefined
        ? undefined
        : dereferenceOne(document, match.operation.requestBody),
    componentSchemas: document.components?.schemas,
    additionalQueryProperties: false,
  } as ValidatorArgs);

  const errors = validator.validateRequest({
    headers: { "content-type": "application/json" },
    params: coerceText(match.params, parameters, "path"),
    query: coerceText(query, parameters, "query"),
    body,
  }) as { errors?: { path?: string; message: string }[] } | undefined;

  if (errors?.errors !== undefined && errors.errors.length > 0) {
    const detail = errors.errors
      .map((error) => `${error.path ?? "?"} ${error.message}`)
      .join("; ");
    return `${spec}: ${method} ${match.operationPath} does not validate: ${detail}`;
  }
  return undefined;
}

/**
 * A URL is text; a document that says `per_page` or `installation_id` is an integer means the
 * integer that text spells. Coercion is narrowed to the path and the query on purpose — a JSON
 * body arrives typed, and a client that sends `"7"` where the document says `7` is drift the
 * harness should catch.
 */
function coerceText(
  values: Record<string, string>,
  parameters: readonly unknown[],
  where: "path" | "query",
): Record<string, unknown> {
  const coerced: Record<string, unknown> = { ...values };
  for (const parameter of parameters as { name: string; in: string; schema?: { type?: string } }[]) {
    const raw = coerced[parameter.name];
    if (parameter.in !== where || typeof raw !== "string") continue;
    if (parameter.schema?.type === "integer" || parameter.schema?.type === "number") {
      const value = Number(raw);
      if (!Number.isNaN(value)) coerced[parameter.name] = value;
    } else if (parameter.schema?.type === "boolean" && (raw === "true" || raw === "false")) {
      coerced[parameter.name] = raw === "true";
    }
  }
  return coerced;
}

interface OperationMatch {
  operationPath: string;
  operation: OpenApiOperation;
  params: Record<string, string>;
}

function findOperation(
  document: OpenApiDocument,
  method: string,
  pathname: string,
): OperationMatch | undefined {
  for (const [operationPath, item] of Object.entries(document.paths)) {
    const operation = item[method.toLowerCase() as "get"];
    if (operation === undefined) continue;

    // GitHub marks `{ref}` `x-multi-segment`, because `heads/main` is one parameter.
    const multiSegment = new Set(
      dereference(document, [...(item.parameters ?? []), ...(operation.parameters ?? [])])
        .filter((parameter) => (parameter as { "x-multi-segment"?: boolean })["x-multi-segment"])
        .map((parameter) => (parameter as { name: string }).name),
    );

    const names: string[] = [];
    const pattern = new RegExp(
      `^${operationPath.replace(/\{([^}]+)\}/g, (_, name: string) => {
        names.push(name);
        return multiSegment.has(name) ? "(.+)" : "([^/]+)";
      })}$`,
    );
    const found = pattern.exec(pathname);
    if (found === null) continue;

    const params: Record<string, string> = {};
    names.forEach((name, index) => {
      params[name] = decodeURIComponent(found[index + 1]!);
    });
    return { operationPath, operation, params };
  }
  return undefined;
}

/**
 * Resolves the `$ref`s the validator cannot: it is given `components.schemas` directly, but a
 * parameter or request body that is itself a `$ref` never reaches that lookup.
 */
function dereference(document: OpenApiDocument, nodes: readonly unknown[]): unknown[] {
  return nodes.map((node) => dereferenceOne(document, node));
}

function dereferenceOne(document: OpenApiDocument, node: unknown): unknown {
  const ref = (node as { $ref?: string }).$ref;
  if (ref === undefined) return node;
  let resolved: unknown = document;
  for (const part of ref.slice(2).split("/")) {
    resolved = (resolved as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return dereferenceOne(document, resolved);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === "") return undefined;
  return JSON.parse(text);
}

/** msw speaks `:param`; the routes are written in the document's own `{param}`. */
function toMswPath(url: string): string {
  return url.replace(/\{([^}]+)\}/g, ":$1");
}
