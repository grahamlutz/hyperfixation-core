import { createTransport, segment, type FetchLike, type Transport } from "./http.js";

export const CLOUDFLARE_API_URL = "https://api.cloudflare.com/client/v4";

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

/** Cloudflare wraps every answer; `success: false` still arrives as HTTP 200 on some routes. */
export interface CloudflareEnvelope<Result> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: Result;
}

/**
 * The one record `hf new` writes: `A <app>.<HF_BASE_DOMAIN>` → `HF_BOX_IP`, DNS-only.
 *
 * `proxied: false` is the decided domain scheme — Coolify's proxy terminates TLS, and a
 * proxied record would both need Full-strict and hide the box from Coolify's ACME challenge.
 */
export interface CloudflareARecord {
  type: "A";
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  comment?: string;
}

export interface CloudflareClientOptions {
  /** `HF_CLOUDFLARE_TOKEN`. */
  token: string;
  /** Overridden only by tests; the real API has one address. */
  url?: string;
  fetch?: FetchLike;
}

export class CloudflareClient {
  private readonly request: Transport;

  constructor(options: CloudflareClientOptions) {
    this.request = createTransport({
      provider: "cloudflare",
      baseUrl: options.url ?? CLOUDFLARE_API_URL,
      headers: { authorization: `Bearer ${options.token}` },
      fetch: options.fetch,
    });
  }

  async listDnsRecords(
    zoneId: string,
    filters: { name?: string; type?: string } = {},
  ): Promise<CloudflareEnvelope<CloudflareDnsRecord[]>> {
    return await this.request({
      method: "GET",
      path: `/zones/${segment(zoneId)}/dns_records`,
      query: { name: filters.name, type: filters.type },
    });
  }

  async createDnsRecord(
    zoneId: string,
    record: CloudflareARecord,
  ): Promise<CloudflareEnvelope<CloudflareDnsRecord>> {
    return await this.request({
      method: "POST",
      path: `/zones/${segment(zoneId)}/dns_records`,
      body: record,
    });
  }
}
