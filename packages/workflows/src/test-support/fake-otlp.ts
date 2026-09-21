import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { trace } from "@opentelemetry/api";

export interface OtlpRequest {
  path: string | undefined;
  headers: IncomingHttpHeaders;
  /** The protobuf body's length; its contents are the OTel SDK's business, not this repo's. */
  byteLength: number;
}

export interface FakeOtlp {
  /** What `LANGFUSE_BASE_URL` is set to; the processor appends `/api/public/otel/v1/traces`. */
  baseUrl: string;
  requests: OtlpRequest[];
  close(): Promise<void>;
}

/**
 * Langfuse's OTLP endpoint, on localhost: what a span export posts and under which headers. The
 * real one is reached over the same path with the same Basic auth, so a test that sees a request
 * here has proved the processor was attached to the provider the app's tracers resolve through.
 */
export async function startFakeOtlp(): Promise<FakeOtlp> {
  const requests: OtlpRequest[] = [];
  const server: Server = createServer((req, res) => {
    let byteLength = 0;
    req.on("data", (chunk: Buffer) => (byteLength += chunk.length));
    req.on("end", () => {
      requests.push({ path: req.url, headers: req.headers, byteLength });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A span of the one shape Langfuse keeps. `LangfuseSpanProcessor` drops anything that is neither
 * its own tracer's nor a known LLM instrumentation's nor carrying a `gen_ai.*` attribute, so a
 * plainly named span proves nothing about whether the processor was attached. The tracer name is
 * the AI SDK's, which is what `llm.run` creates its spans through.
 */
export function endGenAiSpan(): void {
  trace
    .getTracer("ai")
    .startSpan("ai.generateText", { attributes: { "gen_ai.system": "anthropic" } })
    .end();
}
