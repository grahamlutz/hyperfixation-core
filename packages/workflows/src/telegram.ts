import { timingSafeEqual } from "node:crypto";
import * as z from "zod";
import {
  ApprovalBatchRefused,
  type ApprovalDecisionKind,
  type DecideOptions,
  type DecideResult,
} from "./approvals.js";

/**
 * The callback half of Telegram, and only that half: no bot, no polling, nothing sent. A bot
 * that writes the message carrying these buttons is Phase 6's, along with `hf_telegram_link`
 * and a `TELEGRAM_BOT_TOKEN`; what Phase 2 owns is what happens when a button is pressed.
 */

/** Telegram's own cap on `callback_data`, in bytes — not characters (Bot API "1-64 bytes"). */
export const CALLBACK_DATA_MAX_BYTES = 64;

/** Leads every `callback_data` this package writes, so a foreign button is ignored, not decoded. */
export const CALLBACK_DATA_VERSION = "hf1";

/** The nonce's charset: one byte per character, and no `:` to confuse the separator with. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/;

/** No leading zeros and no sign, so one approval id has exactly one encoding. */
const APPROVAL_ID_PATTERN = /^[1-9][0-9]*$/;

/** What a button can carry. Expiry and cancellation are nobody's button — they are sweeps. */
export type TelegramDecision = Extract<ApprovalDecisionKind, "approved" | "rejected">;

const DECISION_CODES = { approved: "a", rejected: "r" } as const satisfies Record<
  TelegramDecision,
  string
>;

const DECISIONS_BY_CODE = { a: "approved", r: "rejected" } as const satisfies Record<
  string,
  TelegramDecision
>;

export interface TelegramCallbackData {
  approvalId: number;
  decision: TelegramDecision;
  /** Per-message, minted by whoever sent the message; the `decisionKey`'s second half. */
  nonce: string;
}

export class CallbackDataTooLong extends Error {
  constructor(data: string) {
    super(
      `CallbackDataTooLong: ${JSON.stringify(data)} is ${Buffer.byteLength(data)} bytes, over ` +
        `Telegram's ${CALLBACK_DATA_MAX_BYTES}-byte limit on callback_data — shorten the nonce`,
    );
    this.name = "CallbackDataTooLong";
  }
}

/**
 * `hf1:<a|r>:<approvalId>:<nonce>`. Fixed-width fields would leave less room for the nonce than
 * the separator does, and the version leads so a button from an older deploy decodes or is
 * ignored rather than being misread.
 */
export function encodeCallbackData(data: TelegramCallbackData): string {
  if (!APPROVAL_ID_PATTERN.test(String(data.approvalId))) {
    throw new TypeError(`encodeCallbackData: ${data.approvalId} is not an approval id`);
  }
  if (!NONCE_PATTERN.test(data.nonce)) {
    throw new TypeError(
      `encodeCallbackData: nonce ${JSON.stringify(data.nonce)} is not [A-Za-z0-9_-]+`,
    );
  }
  const encoded =
    `${CALLBACK_DATA_VERSION}:${DECISION_CODES[data.decision]}:` +
    `${data.approvalId}:${data.nonce}`;
  if (Buffer.byteLength(encoded) > CALLBACK_DATA_MAX_BYTES) throw new CallbackDataTooLong(encoded);
  return encoded;
}

/** The longest nonce that still fits beside this approval id; how a sender picks its width. */
export function maxNonceLength(approvalId: number): number {
  return CALLBACK_DATA_MAX_BYTES - `${CALLBACK_DATA_VERSION}:a:${approvalId}:`.length;
}

/** `null` for anything that is not one of ours — nothing here throws on a foreign button. */
export function decodeCallbackData(data: string | undefined): TelegramCallbackData | null {
  if (data === undefined) return null;
  if (Buffer.byteLength(data) > CALLBACK_DATA_MAX_BYTES) return null;
  const parts = data.split(":");
  if (parts.length !== 4) return null;
  const [version, code, id, nonce] = parts as [string, string, string, string];
  if (version !== CALLBACK_DATA_VERSION) return null;
  if (!Object.hasOwn(DECISIONS_BY_CODE, code)) return null;
  if (!APPROVAL_ID_PATTERN.test(id)) return null;
  const approvalId = Number(id);
  if (!Number.isSafeInteger(approvalId)) return null;
  if (!NONCE_PATTERN.test(nonce)) return null;
  return {
    approvalId,
    decision: DECISIONS_BY_CODE[code as keyof typeof DECISIONS_BY_CODE],
    nonce,
  };
}

/** The approval and the message that offered it, which is what makes a redelivery a replay. */
export function decisionKeyFor(data: TelegramCallbackData): string {
  return `${data.approvalId}:${data.nonce}`;
}

/** As much of Telegram's `User` as a decision needs; the rest of the object rides along. */
export interface TelegramCallbackFrom {
  id: number;
  username?: string;
}

const CallbackUpdate = z.looseObject({
  callback_query: z.looseObject({
    id: z.string(),
    data: z.string().optional(),
    from: z.looseObject({ id: z.number(), username: z.string().optional() }),
  }),
});

export interface TelegramCallbackOptions {
  /**
   * `app.approvals.decide` — the one way an approval is decided. Handed in because `workflows`
   * cannot import `core`, and because nothing here owns a control pool or a `DBOSClient`.
   */
  decide(options: DecideOptions): Promise<DecideResult>;
  /**
   * The `X-Telegram-Bot-Api-Secret-Token` pair: what the webhook was registered with, and what
   * this request carried. Both halves together, because a configured secret with nothing to
   * compare it against would be a webhook anybody can post to.
   */
  secret?: { expected: string; received: string | undefined };
  /**
   * The Telegram user to the app user id written as `decided_by`, which Phase 6's
   * `hf_telegram_link` will answer. Undefined leaves the decision unattributed.
   */
  userFor?: (from: TelegramCallbackFrom) => string | null | undefined;
  /** True when the resolved user holds the admin role — `DecideOptions.admin`'s meaning. */
  admin?: boolean;
}

/**
 * `decided` covers the replay too: one delivery or three, the outcome is the decision that was
 * written. `refused` is a callback that named nothing decidable — an unknown approval, a row
 * someone else already decided, a stale nonce. `ignored` is an update this handler has no
 * business with at all.
 */
export type TelegramCallbackOutcome = "decided" | "refused" | "ignored";

export interface TelegramCallbackResult {
  outcome: TelegramCallbackOutcome;
  /** `callback_query.id`, which Phase 6's bot answers; null when the update carried none. */
  callbackQueryId: string | null;
  approvalId: number | null;
  decision: TelegramDecision | null;
  decisionKey: string | null;
  /** True when this exact callback had already been decided: two deliveries, one decision. */
  replayed: boolean;
  /** Why nothing was decided; null when something was. */
  reason: string | null;
}

/**
 * A Telegram `callback_query` update, decoded and turned into one `decide()` call with
 * `via: 'telegram'` and `decisionKey = <approvalId>:<nonce>`, so a redelivery of the same button
 * press returns the first decision and writes nothing.
 *
 * Every permanent failure comes back as a result: a webhook that answers Telegram with an error
 * is redelivered, and a callback that can never succeed would be redelivered forever. A
 * transient failure — a lost commit, a deadlock, a dead connection — still throws, because that
 * one *should* be retried, and so does a wiring bug.
 */
export async function handleTelegramCallback(
  update: unknown,
  options: TelegramCallbackOptions,
): Promise<TelegramCallbackResult> {
  // Before the payload is looked at, let alone trusted.
  if (options.secret !== undefined && !secretMatches(options.secret)) {
    return ignored(null, "the request's secret token did not match the webhook's");
  }
  const parsed = CallbackUpdate.safeParse(update);
  if (!parsed.success) return ignored(null, "the update carries no callback_query");
  const query = parsed.data.callback_query;

  const data = decodeCallbackData(query.data);
  if (data === null) {
    return ignored(query.id, `callback data ${JSON.stringify(query.data ?? null)} is not ours`);
  }
  const decisionKey = decisionKeyFor(data);

  try {
    const result = await options.decide({
      ids: [data.approvalId],
      decision: data.decision,
      via: "telegram",
      decisionKey,
      userId: options.userFor?.(query.from) ?? null,
      ...(options.admin === undefined ? {} : { admin: options.admin }),
    });
    return {
      outcome: "decided",
      callbackQueryId: query.id,
      approvalId: data.approvalId,
      decision: data.decision,
      decisionKey,
      replayed: result.replayed,
      reason: null,
    };
  } catch (error) {
    if (!(error instanceof ApprovalBatchRefused)) throw error;
    return {
      outcome: "refused",
      callbackQueryId: query.id,
      approvalId: data.approvalId,
      decision: data.decision,
      decisionKey,
      replayed: false,
      reason: error.reasons.map((r) => `${r.approvalId} ${r.reason}`).join("; "),
    };
  }
}

function secretMatches(secret: { expected: string; received: string | undefined }): boolean {
  if (secret.received === undefined) return false;
  const expected = Buffer.from(secret.expected);
  const received = Buffer.from(secret.received);
  // `timingSafeEqual` throws on a length mismatch, which is not secret anyway.
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function ignored(callbackQueryId: string | null, reason: string): TelegramCallbackResult {
  return {
    outcome: "ignored",
    callbackQueryId,
    approvalId: null,
    decision: null,
    decisionKey: null,
    replayed: false,
    reason,
  };
}
