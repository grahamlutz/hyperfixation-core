/**
 * The ledger's crash-harness flow: a loop of `llm.run` calls, one per key, importable by both a
 * test (for its constants and to enqueue it) and the fixture entrypoints that run it — the same
 * split `upsert-flow.ts` uses in `@hyperfixation/workflows`.
 *
 * Three variants of one flow name, one fixture entrypoint each, so "worker B runs different
 * code under a new SHA" is a different module rather than a different branch of the same one.
 */
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import {
  MockLanguageModel,
  type KillAtControl,
  type WorkerControl,
} from "@hyperfixation/testing";
import { parkFor, workerControl } from "@hyperfixation/testing/worker";
import { defineFlow, step, type Flow } from "@hyperfixation/workflows";
import { llm } from "../llm-run.js";

export const LLM_FLOW_NAME = "llmFlow";

/** `<marker> <key>`, one line per call that actually reached the provider. */
export const PROVIDER_CALL_MARKER = "hf-llm-fixture: provider call";

export const FAILED_BEFORE_LOOP = "the v2 flow fails before it reaches the loop";

export interface LlmFlowInput {
  keys: string[];
  estimatedCostUsd: number;
  costUsd: number;
}

export interface LlmFlowControl extends WorkerControl {
  killAt?: KillAtControl;
}

export interface LlmFlowVariant {
  /** New code in front of work the ledger has to replay, which is what makes v2 v2. */
  extraStep?: boolean;
  /** Case 9's v2: the run dies before it can reach its own `started` row. */
  throwBeforeLoop?: boolean;
}

let flow: Flow<LlmFlowInput, void> | undefined;

export function llmFlow(variant: LlmFlowVariant = {}): Flow<LlmFlowInput, void> {
  flow ??= defineFlow<LlmFlowInput, void>(
    LLM_FLOW_NAME,
    async (input) => {
      const control = workerControl<LlmFlowControl>();

      if (variant.extraStep === true) await step("prepare", () => Promise.resolve());
      if (variant.throwBeforeLoop === true) throw new Error(FAILED_BEFORE_LOOP);

      const model = new MockLanguageModel({
        responses: input.keys.map((key) => ({
          text: `answer:${key}`,
          inputTokens: 10,
          outputTokens: 5,
        })),
      });

      for (const key of input.keys) {
        await step(
          "draft",
          (ctx) =>
            llm.run(ctx, {
              key: ctx.key,
              prompt: "draft one line",
              input: { key },
              estimatedCostUsd: input.estimatedCostUsd,
              costUsd: input.costUsd,
              model: parkingModel(model, key, control.killAt),
            }),
          { key },
        );
        await parkFor(control.killAt, "after-checkpoint", key);
      }
    },
    { queue: "llm" },
  );
  return flow;
}

/**
 * The cassette, wrapped so each call announces itself and can be held at the one point the
 * ledger cannot recover from cleanly: the provider has answered — and would be billed — while
 * the row is still `started` and DBOS has checkpointed nothing. That is the state redeploy
 * case 2 kills in, and the only one that produces a `possible_double_charge`.
 */
function parkingModel(
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
      throw new Error("the ledger fixture model does not stream");
    },
  };
}
