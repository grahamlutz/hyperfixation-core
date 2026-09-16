/**
 * The cassette: canned provider answers a test arranges up front, handed back one per call.
 *
 * It implements `LanguageModelV4` — the AI SDK's *provider* interface, the one a real
 * provider satisfies — rather than stubbing `generateText`/`generateObject`. That is what
 * makes it a drop-in for a provider under `@hyperfixation/ai`'s `llm.run` (chunk 10) without
 * the code under test knowing it is mocked: the SDK's own prompt conversion, tool handling
 * and telemetry all still run.
 */
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";

export const MOCK_PROVIDER = "hyperfixation-mock";
export const MOCK_MODEL_ID = "mock-model";

export interface CassetteResponse {
  /** The assistant's text; shorthand for a single `{ type: "text" }` content part. */
  text?: string;
  /** Content parts in full, for anything `text` cannot say (tool calls, reasoning). */
  content?: LanguageModelV4Content[];
  finishReason?: LanguageModelV4FinishReason["unified"];
  inputTokens?: number;
  outputTokens?: number;
  /** Thrown from `doGenerate` instead of returned — the provider-failure branch. */
  error?: Error;
}

export interface MockLanguageModelOptions {
  provider?: string;
  modelId?: string;
  /** Answered in order, one per call. */
  responses?: CassetteResponse[];
}

export class CassetteExhausted extends Error {
  readonly callCount: number;

  constructor(modelId: string, callCount: number) {
    super(
      `CassetteExhausted: ${modelId} was called ${callCount} time` +
        `${callCount === 1 ? "" : "s"} but the cassette has no response left`,
    );
    this.name = "CassetteExhausted";
    this.callCount = callCount;
  }
}

export class MockLanguageModel implements LanguageModelV4 {
  readonly specificationVersion = "v4";
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  /** Every call the model received, in order, exactly as the SDK built it. */
  readonly calls: LanguageModelV4CallOptions[] = [];

  private readonly responses: CassetteResponse[];

  constructor(options: MockLanguageModelOptions = {}) {
    this.provider = options.provider ?? MOCK_PROVIDER;
    this.modelId = options.modelId ?? MOCK_MODEL_ID;
    this.responses = [...(options.responses ?? [])];
  }

  get callCount(): number {
    return this.calls.length;
  }

  /** Adds to the tail of the cassette, for a test that arranges a second round mid-way. */
  enqueue(...responses: CassetteResponse[]): this {
    this.responses.push(...responses);
    return this;
  }

  doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    this.calls.push(options);
    const response = this.responses.shift();
    // Never a default answer: a call the test did not arrange is the test being wrong about
    // how many provider calls its code makes, which is the thing chunk 10's cases assert.
    if (response === undefined) {
      return Promise.reject(new CassetteExhausted(this.modelId, this.calls.length));
    }
    if (response.error !== undefined) return Promise.reject(response.error);

    const inputTokens = response.inputTokens ?? 0;
    const outputTokens = response.outputTokens ?? 0;
    return Promise.resolve({
      content: response.content ?? [{ type: "text", text: response.text ?? "" }],
      finishReason: { unified: response.finishReason ?? "stop", raw: undefined },
      usage: {
        inputTokens: {
          total: inputTokens,
          noCache: inputTokens,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
      },
      warnings: [],
    });
  }

  /** Streaming is not recorded; chunk 10's `llm.run` calls `generateText`/`generateObject`. */
  doStream(): never {
    throw new Error(`${this.modelId}: MockLanguageModel does not record streamed calls`);
  }
}
