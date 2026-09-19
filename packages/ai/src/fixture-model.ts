/**
 * The fixture provider: canned answers on disk, so `hf up` on a laptop with no
 * `ANTHROPIC_API_KEY` still runs the loop end to end and CI can count provider calls.
 *
 * Like `MockLanguageModel` it implements `LanguageModelV4` rather than stubbing the SDK, so the
 * prompt conversion, the schema path and the telemetry all still run. The entry is chosen by
 * `providerOptions.hyperfixation.promptName`, which `llm.run` puts on every call.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { FixtureMissing } from "./errors.js";

export const FIXTURE_PROVIDER = "hyperfixation-fixture";

export interface FixtureWhen {
  /** Matched against the last user message's text, case-insensitively. */
  userTextIncludes?: string;
}

export interface FixtureResponse {
  when?: FixtureWhen;
  /** Returned as the JSON text of the answer; what the `schema` path parses. */
  json?: unknown;
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface FixtureFile {
  responses?: FixtureResponse[];
}

export interface FixtureModelOptions {
  /** Where `<promptName>.json` resolves. */
  dir: string;
  modelId: string;
}

export function createFixtureModel({ dir, modelId }: FixtureModelOptions): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: FIXTURE_PROVIDER,
    modelId,
    supportedUrls: {},
    doGenerate: (options) => generate(dir, modelId, options),
    doStream: () => {
      throw new Error(`${modelId}: the fixture provider does not serve streamed calls`);
    },
  };
}

async function generate(
  dir: string,
  modelId: string,
  options: LanguageModelV4CallOptions,
): Promise<LanguageModelV4GenerateResult> {
  const promptName = promptNameOf(options);
  if (promptName === undefined) {
    throw new FixtureMissing(
      modelId,
      dir,
      "the call carried no providerOptions.hyperfixation.promptName",
    );
  }

  const file = join(dir, `${promptName}.json`);
  let parsed: FixtureFile;
  try {
    // Read per call, never cached, for the same reason prompt files are: an edited fixture
    // takes effect without a restart.
    parsed = JSON.parse(await readFile(file, "utf8")) as FixtureFile;
  } catch (cause) {
    throw new FixtureMissing(modelId, file, "does not resolve to a readable JSON file", { cause });
  }

  const userText = lastUserTextOf(options);
  const response = select(parsed.responses ?? [], userText);
  if (response === undefined) {
    throw new FixtureMissing(
      modelId,
      file,
      `has no entry matching the user text ${JSON.stringify(userText)} and no default entry`,
    );
  }

  const text = response.json !== undefined ? JSON.stringify(response.json) : (response.text ?? "");
  // Zero by default, so a fixture run never moves `spent_usd`.
  const inputTokens = response.inputTokens ?? 0;
  const outputTokens = response.outputTokens ?? 0;
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: undefined },
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
  };
}

/** The first `when` that matches, else the first entry without one — never a silent default. */
function select(responses: FixtureResponse[], userText: string): FixtureResponse | undefined {
  const haystack = userText.toLowerCase();
  for (const response of responses) {
    const needle = response.when?.userTextIncludes;
    if (needle !== undefined && haystack.includes(needle.toLowerCase())) return response;
  }
  return responses.find((response) => response.when === undefined);
}

function promptNameOf(options: LanguageModelV4CallOptions): string | undefined {
  const join = options.providerOptions?.["hyperfixation"];
  const promptName = join?.["promptName"];
  return typeof promptName === "string" ? promptName : undefined;
}

function lastUserTextOf(options: LanguageModelV4CallOptions): string {
  for (let i = options.prompt.length - 1; i >= 0; i -= 1) {
    const message = options.prompt[i]!;
    if (message.role !== "user") continue;
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return "";
}
