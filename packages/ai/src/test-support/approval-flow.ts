/**
 * The gate cases' flow: `llm.run` keys, then a `waitForApproval`, then an `actions.perform`.
 * Importable by the tests (for its constants and to enqueue it) and by the fixture entrypoints
 * that run it, the same split `llm-flow.ts` uses.
 *
 * Two variants of one flow name, one entrypoint each, so "worker B runs different code under a
 * new SHA" is a different module rather than a different branch of the same one.
 */
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import {
  MockLanguageModel,
  MOCK_MODEL_ID,
  type KillAtControl,
  type WorkerControl,
} from "@hyperfixation/testing";
import { parkFor, workerClock, workerControl } from "@hyperfixation/testing/worker";
import {
  actions,
  defineFlow,
  step,
  waitForApproval,
  type ActionChannel,
  type Flow,
} from "@hyperfixation/workflows";
import { createLlm } from "../llm-run.js";
import { createProviders, fixedCost } from "../providers.js";
import { PROVIDER_CALL_MARKER } from "./llm-flow.js";
import { PROMPTS_DIR } from "./prompts-dir.js";

export const APPROVAL_FLOW_NAME = "approvalFlow";
export const APPROVAL_KEY = "send";
export const APPROVAL_TYPE = "send-email";
export const CLASSIFY_KEY = "classify";

/** `<marker> <idempotency key>`, one line per dispatch that reached the channel. */
export const ACTION_SENT_MARKER = "hf-approval-fixture: action sent";

/** `<marker> <json>` once the gate returns a decision. */
export const DECISION_MARKER = "hf-approval-fixture: decision";

export interface ApprovalFlowInput {
  keys: string[];
  estimatedCostUsd: number;
  costUsd: number;
}

export interface ApprovalFlowControl extends WorkerControl {
  killAt?: KillAtControl;
}

export interface ApprovalFlowVariant {
  /** v2's new ledger key, inserted in front of the gate the previous SHA stopped at. */
  classify?: boolean;
  /** v2's new step after the gate, so the resumed attempt runs code v1 never had. */
  extraStepAfter?: boolean;
}

let flow: Flow<ApprovalFlowInput, void> | undefined;

export function approvalFlow(variant: ApprovalFlowVariant = {}): Flow<ApprovalFlowInput, void> {
  flow ??= defineFlow<ApprovalFlowInput, void>(
    APPROVAL_FLOW_NAME,
    async (input) => {
      const control = workerControl<ApprovalFlowControl>();
      const model = cassette(input, variant);

      for (const key of input.keys) {
        await step(
          "draft",
          (ctx) =>
            ledgerFor(announcing(model, key, control.killAt), input).run(ctx, {
              key: ctx.key,
              model: MOCK_MODEL_ID,
              prompt: "draft",
              input: { key },
            }),
          { key },
        );
        await parkFor(control.killAt, "after-checkpoint", key);
      }

      if (variant.classify === true) {
        await step(
          "classify",
          (ctx) =>
            ledgerFor(announcing(model, CLASSIFY_KEY, control.killAt), input).run(ctx, {
              key: ctx.key,
              model: MOCK_MODEL_ID,
              prompt: "classify",
              input: { key: CLASSIFY_KEY },
            }),
          { key: CLASSIFY_KEY },
        );
      }

      const decision = await waitForApproval({
        key: APPROVAL_KEY,
        type: APPROVAL_TYPE,
        draft: { body: "draft" },
      });
      console.log(`${DECISION_MARKER} ${JSON.stringify({ status: decision.status })}`);

      if (variant.extraStepAfter === true) {
        await step("record-decision", () => Promise.resolve(), { key: "record-decision" });
      }

      await step(
        "send",
        (ctx) => actions.perform(ctx, { key: ctx.key, channel: announcingChannel() }),
        { key: APPROVAL_KEY },
      );
    },
    { queue: "llm" },
  );
  return flow;
}

/** One registry per call: the wrapped model is per key, the same way `llm-flow.ts` builds it. */
function ledgerFor(model: LanguageModelV4, input: ApprovalFlowInput): ReturnType<typeof createLlm> {
  return createLlm({
    providers: createProviders({
      models: { [MOCK_MODEL_ID]: model },
      costs: { [MOCK_MODEL_ID]: fixedCost(input.estimatedCostUsd, input.costUsd) },
    }),
    promptsDir: PROMPTS_DIR,
    clock: workerClock(),
  });
}

/** One response per key the flow can reach, in the order it reaches them. */
function cassette(input: ApprovalFlowInput, variant: ApprovalFlowVariant): MockLanguageModel {
  const keys = variant.classify === true ? [...input.keys, CLASSIFY_KEY] : input.keys;
  return new MockLanguageModel({
    responses: keys.map((key) => ({ text: `answer:${key}`, inputTokens: 10, outputTokens: 5 })),
  });
}

/** Each provider call announces itself, and can be held at the point a crash costs money. */
function announcing(
  base: MockLanguageModel,
  key: string,
  killAt: KillAtControl | undefined,
): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: base.provider,
    modelId: base.modelId,
    supportedUrls: base.supportedUrls,
    async doGenerate(
      options: LanguageModelV4CallOptions,
    ): Promise<LanguageModelV4GenerateResult> {
      const result = await base.doGenerate(options);
      console.log(`${PROVIDER_CALL_MARKER} ${key}`);
      await parkFor(killAt, "before-checkpoint", key);
      return result;
    },
    doStream(): never {
      throw new Error("the approvals fixture model does not stream");
    },
  };
}

/** The stub channel, with a line per dispatch: "the action went out exactly once" is countable. */
function announcingChannel(): ActionChannel {
  return {
    name: "stub",
    dedupes: true,
    send: (dispatch) => {
      console.log(`${ACTION_SENT_MARKER} ${dispatch.idempotencyKey}`);
      return Promise.resolve({ externalId: dispatch.idempotencyKey, response: { stub: true } });
    },
  };
}
