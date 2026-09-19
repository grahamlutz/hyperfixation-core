/**
 * A provider call held open. The gate has committed its `started` row and the answer is still in
 * flight — the one window a kill can orphan a row in, and the only one in which the row's own
 * reservation is there to be read.
 *
 * In-process, so a case that only needs a call parked mid-flight needs no worker at all.
 */
import type { LanguageModelV4, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MOCK_MODEL_ID, MOCK_PROVIDER } from "@hyperfixation/testing";

export class ParkedCall implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider = MOCK_PROVIDER;
  readonly modelId = MOCK_MODEL_ID;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  /** Resolves once the gate has committed and the provider has been entered. */
  readonly entered: Promise<void>;
  calls = 0;

  private enter!: () => void;
  private answer: ((result: LanguageModelV4GenerateResult) => void) | undefined;

  constructor() {
    this.entered = new Promise<void>((resolve) => {
      this.enter = resolve;
    });
  }

  doGenerate(): Promise<LanguageModelV4GenerateResult> {
    this.calls += 1;
    this.enter();
    return new Promise((resolve) => {
      this.answer = resolve;
    });
  }

  /** Lets the parked call answer, which is what carries its row to `ok`. */
  release(text: string): void {
    this.answer?.({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    });
  }

  doStream(): never {
    throw new Error(`${this.modelId}: a parked call is never streamed`);
  }
}
