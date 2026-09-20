import { requireOperatorConfig } from "../config.js";
import type { Step } from "../new-cloud.js";
import { CloudflareClient, type CloudflareEnvelope } from "../providers/cloudflare.js";
import { StepFailed, type CloudStepContext } from "./context.js";

/** Cloudflare's "automatic"; the record is DNS-only, so nothing caches it for long. */
const TTL_AUTOMATIC = 1;

/**
 * `A <app>.<HF_BASE_DOMAIN>` → `HF_BOX_IP`, DNS-only, and exactly one of them.
 *
 * An existing record with the right address is the step's own previous work. One with a different
 * address is somebody's live hostname: it is never overwritten, and a second A record is never
 * added either — two of them would round-robin between the box and whatever that is, which looks
 * like an intermittent outage rather than a misconfiguration.
 */
export const dnsStep: Step<CloudStepContext> = {
  name: "dns",
  run: async (context) => {
    const { names } = context;
    const required = requireOperatorConfig(
      context.config,
      ["HF_CLOUDFLARE_TOKEN", "HF_CLOUDFLARE_ZONE_ID", "HF_BASE_DOMAIN", "HF_BOX_IP"],
      { env: context.env },
    );
    const fqdn = `${names.given}.${required.HF_BASE_DOMAIN}`;

    const cloudflare = new CloudflareClient({
      token: required.HF_CLOUDFLARE_TOKEN,
      fetch: context.fetch,
    });

    const listed = assertSuccess(
      await cloudflare.listDnsRecords(required.HF_CLOUDFLARE_ZONE_ID, { name: fqdn, type: "A" }),
      `list the A records for ${fqdn}`,
    );

    const existing = listed[0];
    if (existing !== undefined) {
      if (existing.content !== required.HF_BOX_IP) {
        throw new StepFailed(
          `${fqdn} already has an A record pointing at ${existing.content}, not the box at ` +
            `${required.HF_BOX_IP}: hf new neither overwrites an A record nor adds a second one. ` +
            `Point it at the box, or delete it, and re-run hf new.`,
        );
      }
      context.io.out(`${names.given}: ${fqdn} already points at ${required.HF_BOX_IP}`);
      return;
    }

    assertSuccess(
      await cloudflare.createDnsRecord(required.HF_CLOUDFLARE_ZONE_ID, {
        type: "A",
        name: fqdn,
        content: required.HF_BOX_IP,
        ttl: TTL_AUTOMATIC,
        proxied: false,
        comment: `hf new ${names.given}`,
      }),
      `create the A record for ${fqdn}`,
    );
    context.io.out(`${names.given}: ${fqdn} A ${required.HF_BOX_IP}, DNS-only`);
  },
};

/** Cloudflare answers `success: false` with HTTP 200 on some routes, which no transport catches. */
function assertSuccess<Result>(envelope: CloudflareEnvelope<Result>, what: string): Result {
  if (!envelope.success) {
    const detail = envelope.errors.map((error) => error.message).join("; ");
    throw new StepFailed(`cloudflare could not ${what}${detail === "" ? "" : `: ${detail}`}`);
  }
  return envelope.result;
}
