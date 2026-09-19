/**
 * The provider registry: one place that turns a model *name* into both the SDK model a call
 * needs and the price the ledger charges for it. A flow names a string; nothing in a flow ever
 * holds a provider object or a dollar figure.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { UnknownModel } from "./errors.js";

export type CostProvider = "anthropic" | "openai";

/** What the gate knows before the call: the bytes going out, and the cap on what comes back. */
export interface CostEstimateCall {
  promptBytes: number;
  inputBytes: number;
  maxOutputTokens?: number;
}

export interface CostActualUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ModelCost {
  /** Which configured client resolves the name when `models` does not name it. */
  provider?: CostProvider;
  /** `estimated_cost_usd`, charged against the budget before the call. */
  estimate(call: CostEstimateCall): number;
  /** `cost_usd`, from what the provider says it billed. */
  actual(usage: CostActualUsage): number;
}

export interface ProviderRegistry {
  model(name: string): LanguageModelV4;
  cost(name: string): ModelCost;
}

export interface CreateProvidersOptions {
  anthropic?: { apiKey: string };
  openai?: { apiKey: string };
  /** Explicit entries win over a provider lookup: the mock and fixture seam. */
  models?: Record<string, LanguageModelV4>;
  /** Merged over `DEFAULT_COSTS`, so an app can reprice a row without replacing the table. */
  costs?: Record<string, ModelCost>;
}

export interface PerMillionTokensRow {
  provider: CostProvider;
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** What the estimate charges for the answer when the call names no `maxOutputTokens`. */
  assumedOutputTokens?: number;
}

/** Good enough for a reservation that a real `usage` corrects minutes later. */
const BYTES_PER_TOKEN = 4;
const PER_MILLION = 1_000_000;
const DEFAULT_ASSUMED_OUTPUT_TOKENS = 1_000;

export function perMillionTokens(row: PerMillionTokensRow): ModelCost {
  const assumed = row.assumedOutputTokens ?? DEFAULT_ASSUMED_OUTPUT_TOKENS;
  return {
    provider: row.provider,
    estimate: (call) =>
      ((call.promptBytes + call.inputBytes) / BYTES_PER_TOKEN / PER_MILLION) * row.input +
      ((call.maxOutputTokens ?? assumed) / PER_MILLION) * row.output,
    actual: (usage) =>
      ((usage.inputTokens ?? 0) / PER_MILLION) * row.input +
      ((usage.outputTokens ?? 0) / PER_MILLION) * row.output,
  };
}

/** Two flat numbers, for a test or a fixture model that has no token price at all. */
export function fixedCost(estimateUsd: number, costUsd: number): ModelCost {
  return { estimate: () => estimateUsd, actual: () => costUsd };
}

/**
 * Published list prices at the time of writing, in USD per million tokens. Every row is a
 * number to re-check against a real bill line before it is trusted, not a constant.
 */
export const DEFAULT_COSTS: Record<string, ModelCost> = {
  "claude-opus-4-5": perMillionTokens({ provider: "anthropic", input: 5, output: 25 }),
  "claude-sonnet-4-5": perMillionTokens({ provider: "anthropic", input: 3, output: 15 }),
  "claude-haiku-4-5": perMillionTokens({ provider: "anthropic", input: 1, output: 5 }),
  "gpt-5": perMillionTokens({ provider: "openai", input: 1.25, output: 10 }),
  "gpt-4.1": perMillionTokens({ provider: "openai", input: 2, output: 8 }),
  "gpt-4o-mini": perMillionTokens({ provider: "openai", input: 0.15, output: 0.6 }),
};

export function createProviders(options: CreateProvidersOptions = {}): ProviderRegistry {
  const costs = { ...DEFAULT_COSTS, ...options.costs };
  const models = options.models ?? {};
  const clients = new Map<CostProvider, (name: string) => LanguageModelV4>();

  if (options.anthropic !== undefined) {
    const anthropic = createAnthropic({ apiKey: options.anthropic.apiKey });
    clients.set("anthropic", (name) => anthropic.languageModel(name));
  }
  if (options.openai !== undefined) {
    const openai = createOpenAI({ apiKey: options.openai.apiKey });
    clients.set("openai", (name) => openai.languageModel(name));
  }

  return {
    model(name) {
      const explicit = models[name];
      if (explicit !== undefined) return explicit;

      const provider = costs[name]?.provider;
      if (provider === undefined) {
        throw new UnknownModel(name, "is not in the cost table and was not passed in `models`");
      }
      const client = clients.get(provider);
      if (client === undefined) {
        throw new UnknownModel(name, `needs the ${provider} provider, which has no api key`);
      }
      return client(name);
    },
    cost(name) {
      const cost = costs[name];
      if (cost === undefined) {
        // A `models` entry with no price would bill the budget zero for every call.
        throw new UnknownModel(name, "has no cost row; name it in `costs`");
      }
      return cost;
    },
  };
}
