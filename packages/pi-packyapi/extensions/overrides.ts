import type { Model } from "@earendil-works/pi-ai";
import type { PACKYAPI_API } from "./models.js";

type CapabilityOverride = Pick<
  Model<typeof PACKYAPI_API>,
  "name" | "reasoning" | "input" | "contextWindow" | "maxTokens" | "thinkingLevelMap" | "compat"
>;

const gptThinkingLevels = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

/** Capability metadata that PackyAPI's pricing endpoint does not provide. */
export const PACKYAPI_MODEL_OVERRIDES: Readonly<Record<string, CapabilityOverride>> = {
  "deepseek-v4-flash": {
    name: "DeepSeek V4 Flash",
    reasoning: true,
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 384_000,
  },
  "gpt-5.6-sol": {
    name: "GPT-5.6 Sol",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    thinkingLevelMap: gptThinkingLevels,
    compat: { supportsOpenAIGrammarTools: true },
  },
  "gpt-5.6-terra": {
    name: "GPT-5.6 Terra",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    thinkingLevelMap: gptThinkingLevels,
    compat: { supportsOpenAIGrammarTools: true },
  },
  "gpt-5.6-luna": {
    name: "GPT-5.6 Luna",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    thinkingLevelMap: gptThinkingLevels,
    compat: { supportsOpenAIGrammarTools: true },
  },
};
