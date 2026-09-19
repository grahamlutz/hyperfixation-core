import { createTransport, segment, type FetchLike, type Transport } from "./http.js";

export const SENTRY_URL = "https://sentry.io";

export interface SentryProject {
  id: string;
  slug: string;
  name: string;
}

export interface SentryProjectKey {
  id: string;
  name: string;
  dsn: { public: string };
}

export interface SentryClientOptions {
  /** `HF_SENTRY_TOKEN`. */
  token: string;
  url?: string;
  fetch?: FetchLike;
}

export class SentryClient {
  private readonly request: Transport;

  constructor(options: SentryClientOptions) {
    this.request = createTransport({
      provider: "sentry",
      baseUrl: options.url ?? SENTRY_URL,
      headers: { authorization: `Bearer ${options.token}` },
      fetch: options.fetch,
    });
  }

  async createProject(
    org: string,
    body: { name: string; slug?: string; platform?: string },
  ): Promise<SentryProject> {
    return await this.request({
      method: "POST",
      path: `/api/0/organizations/${segment(org)}/projects/`,
      body,
    });
  }

  /** The DSN `hf new` writes into `SENTRY_DSN` is `keys[0].dsn.public`. */
  async listProjectKeys(org: string, project: string): Promise<SentryProjectKey[]> {
    return await this.request({
      method: "GET",
      path: `/api/0/projects/${segment(org)}/${segment(project)}/keys/`,
    });
  }
}
