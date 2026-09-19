import { createTransport, segment, type FetchLike, type Transport } from "./http.js";

export interface LangfuseProject {
  id: string;
  name: string;
}

export interface LangfuseApiKey {
  id: string;
  publicKey: string;
  /** Returned once, at creation; Langfuse never shows it again. */
  secretKey: string;
  note?: string;
}

export interface LangfuseClientOptions {
  /** `HF_LANGFUSE_URL` — the instance's origin. */
  url: string;
  /**
   * `HF_LANGFUSE_ORG_KEY`, spelled `<publicKey>:<secretKey>`: Langfuse authenticates with HTTP
   * Basic, and an organization-scoped key is a pair, so the pair is one config value rather
   * than two that can be set out of step with each other.
   */
  orgKey: string;
  fetch?: FetchLike;
}

export class LangfuseClient {
  private readonly request: Transport;

  constructor(options: LangfuseClientOptions) {
    this.request = createTransport({
      provider: "langfuse",
      baseUrl: options.url.replace(/\/+$/, ""),
      headers: {
        authorization: `Basic ${Buffer.from(options.orgKey, "utf8").toString("base64")}`,
      },
      fetch: options.fetch,
    });
  }

  /** `retention` is required by the API: 0 keeps data indefinitely. */
  async createProject(body: {
    name: string;
    retention: number;
    metadata?: Record<string, unknown>;
  }): Promise<LangfuseProject> {
    return await this.request({ method: "POST", path: "/api/public/projects", body });
  }

  async createApiKey(
    projectId: string,
    body: { note?: string } = {},
  ): Promise<LangfuseApiKey> {
    return await this.request({
      method: "POST",
      path: `/api/public/projects/${segment(projectId)}/apiKeys`,
      body,
    });
  }
}
