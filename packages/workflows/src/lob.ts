import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as z from "zod";
import type { ActionChannel, ActionDispatch, ActionResult } from "./actions.js";

/**
 * One letter per `actions.perform`, through Lob's `POST /v1/letters`. The action's
 * `idempotencyKey` is the request's `Idempotency-Key`, which is what earns this channel its
 * `dedupes: true`: a re-entry inside Lob's window returns the first letter rather than mailing a
 * second one.
 */

/** Lob's `Idempotency-Key` is honoured for 24 h; a re-entry later than that is a second letter. */
export const LOB_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export const LOB_BASE_URL = "https://api.lob.com";

/** Lob's own prefixes. A `live_` key mails paper and costs money; see `LobLiveKeyRefused`. */
const TEST_KEY_PREFIX = "test_";
const LIVE_KEY_PREFIX = "live_";

/** How much of a refusal's explanation reaches the message before it is cut. */
export const LOB_EXPLANATION_LIMIT = 500;

/** Lob's `to` and `from`, US only in Phase 6. Exported so an app's allowlist can narrow it. */
export const LobAddress = z.object({
  name: z.string().min(1).max(40),
  line1: z.string().min(1).max(64),
  line2: z.string().max(64).optional(),
  city: z.string().min(1).max(200),
  /** Lob wants the two-letter code, not the name. */
  state: z.string().regex(/^[A-Z]{2}$/),
  zip: z.string().regex(/^\d{5}(-\d{4})?$/),
});

/**
 * The letter a draft becomes. `subject` and `body` are the draft's own fields and reach the page
 * as text nodes, never as markup — see `renderLetter`.
 *
 * Exported so an app's draft schema can be this one, or extend it: the demo's contact allowlist
 * narrows `to` with a `.refine`, and what it produces is what this channel is sent.
 */
export const LobLetterRequest = z.object({
  to: LobAddress,
  from: LobAddress,
  subject: z.string().min(1).max(200),
  body: z.string().min(1),
  /** Lob shows it in the dashboard beside the letter; the X6 evidence is read off it. */
  description: z.string().max(255).optional(),
});

export type LobAddress = z.infer<typeof LobAddress>;
export type LobLetterRequest = z.infer<typeof LobLetterRequest>;

/** A `live_` key on a channel that was not built for one. The key itself is not in the message. */
export class LobLiveKeyRefused extends Error {
  constructor() {
    super(
      "LobLiveKeyRefused: LOB_API_KEY is a live key and this channel was built without " +
        "`live: true`, so it would mail real paper — pass a test_ key, or opt in explicitly",
    );
    this.name = "LobLiveKeyRefused";
  }
}

/**
 * Lob answered outside 2xx. The message carries the status and Lob's own `error.message` and
 * nothing else of the exchange: the request's headers — where the key is — are on neither the
 * message nor this object, and any echo of the key inside the body is blanked before it lands.
 */
export class LobRefused extends Error {
  readonly status: number;

  constructor(status: number, explanation: string | undefined) {
    super(
      `LobRefused: POST /v1/letters failed: HTTP ${status}` +
        (explanation === undefined ? "" : `: ${explanation}`),
    );
    this.name = "LobRefused";
    this.status = status;
  }
}

export interface LobChannelOptions {
  /** `LOB_API_KEY`. Sent as Basic auth's username with an empty password, as Lob specifies. */
  apiKey: string;
  /** Names the channel on `hf_action_log`; a second Lob channel needs a second name. */
  name?: string;
  /** Opts a `live_` key in. Phase 6 leaves it off, so only test-mode letters are mailed. */
  live?: boolean;
  baseUrl?: string;
  /**
   * The draft schema the request is parsed against before anything is sent — the app's own, so
   * its contact allowlist is what decides who a letter may be addressed to. Defaults to the
   * shape only.
   */
  schema?: z.ZodType<LobLetterRequest>;
  fetch?: typeof globalThis.fetch;
}

/**
 * Every draft field is a text node, so React escapes it: a `body` carrying
 * `<img src=x onerror=…>` reaches Lob as characters and is printed as characters. Nothing here
 * interpolates a draft into markup, which is the property the injection test pins.
 */
export function renderLetter(letter: LobLetterRequest): string {
  const paragraphs = letter.body.split(/\n{2,}/);
  return `<!DOCTYPE html>${renderToStaticMarkup(
    h(
      "html",
      { lang: "en" },
      h("head", null, h("meta", { charSet: "utf-8" }), h("style", null, LETTER_CSS)),
      h(
        "body",
        null,
        h("div", { className: "from" }, addressLines(letter.from)),
        h("div", { className: "to" }, addressLines(letter.to)),
        h("h1", null, letter.subject),
        paragraphs.map((text, index) => h("p", { key: index }, text)),
      ),
    ),
  )}`;
}

/** Lob prints US Letter at 96 dpi with a half-inch bleed the address window must clear. */
const LETTER_CSS = [
  "@page { size: 8.5in 11in; margin: 0; }",
  "body { width: 8.5in; height: 11in; margin: 0; padding: 1in 0.75in;",
  "  box-sizing: border-box; font-family: Georgia, serif; font-size: 11pt; }",
  ".from, .to { white-space: pre-line; }",
  ".to { margin-top: 0.5in; }",
  "h1 { font-size: 13pt; margin: 0.4in 0 0.2in; }",
].join("\n");

function addressLines(address: LobAddress): string {
  const line2 = address.line2 === undefined ? [] : [address.line2];
  return [
    address.name,
    address.line1,
    ...line2,
    `${address.city}, ${address.state} ${address.zip}`,
  ].join("\n");
}

/** Lob's own field names, which are not this package's. */
function addressBody(address: LobAddress): Record<string, string> {
  return {
    name: address.name,
    address_line1: address.line1,
    ...(address.line2 === undefined ? {} : { address_line2: address.line2 }),
    address_city: address.city,
    address_state: address.state,
    address_zip: address.zip,
    address_country: "US",
  };
}

/**
 * `dedupes: true` rests on the `Idempotency-Key` header alone, and Lob honours it for
 * `LOB_IDEMPOTENCY_WINDOW_MS`. A row re-entered later than that is not covered — that is the
 * `uncertain` path's problem, not this channel's, and it is still open.
 */
export function lobChannel(options: LobChannelOptions): ActionChannel<LobLetterRequest> {
  if (options.apiKey.startsWith(LIVE_KEY_PREFIX) && options.live !== true) {
    throw new LobLiveKeyRefused();
  }
  if (!options.apiKey.startsWith(TEST_KEY_PREFIX) && !options.apiKey.startsWith(LIVE_KEY_PREFIX)) {
    throw new TypeError("lobChannel: LOB_API_KEY is neither a test_ nor a live_ key");
  }
  const schema = options.schema ?? LobLetterRequest;
  const base = (options.baseUrl ?? LOB_BASE_URL).replace(/\/+$/, "");
  const authorization = `Basic ${Buffer.from(`${options.apiKey}:`).toString("base64")}`;

  return {
    name: options.name ?? "lob",
    dedupes: true,
    async send(dispatch: ActionDispatch<LobLetterRequest>): Promise<ActionResult> {
      const letter = schema.parse(dispatch.request);
      // Looked up per send, so a test's mock server can replace `globalThis.fetch` after the
      // channel was built.
      const doFetch = options.fetch ?? globalThis.fetch;
      const response = await doFetch(`${base}/v1/letters`, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          "idempotency-key": dispatch.idempotencyKey,
        },
        body: JSON.stringify({
          to: addressBody(letter.to),
          from: addressBody(letter.from),
          file: renderLetter(letter),
          color: false,
          ...(letter.description === undefined ? {} : { description: letter.description }),
        }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new LobRefused(response.status, explain(text, [options.apiKey, authorization]));
      }
      const parsed = JSON.parse(text) as { id?: unknown };
      return {
        ...(typeof parsed.id === "string" ? { externalId: parsed.id } : {}),
        response: parsed,
      };
    },
  };
}

/**
 * Why Lob refused, out of its `error.message` and with every secret blanked — the key and the Basic
 * header it was encoded into, because a provider is free to quote what was sent back at it.
 * `undefined` when the body is not JSON or carries no message: a refusal that explained nothing
 * leaves the status to speak rather than putting a page of HTML in a log line.
 */
function explain(body: string, secrets: readonly string[]): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const message = (parsed as { error?: { message?: unknown } }).error?.message;
  if (typeof message !== "string") return undefined;
  let text = message;
  for (const secret of secrets) text = text.split(secret).join("***");
  return text.length > LOB_EXPLANATION_LIMIT
    ? `${text.slice(0, LOB_EXPLANATION_LIMIT)}…`
    : text;
}
