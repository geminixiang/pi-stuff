import type { Api, Model } from "@earendil-works/pi-ai";

export interface PackyAPIModelException {
  readonly headers?: Readonly<Record<string, string>>;
  readonly compat?: Model<Api>["compat"];
}

/** PackyAPI transport exceptions. Capability facts live in the generated catalog. */
export const PACKYAPI_MODEL_EXCEPTIONS: Readonly<Record<string, PackyAPIModelException>> = {
  "gpt-5.4": { compat: { supportsOpenAIGrammarTools: true } },
  "gpt-5.4-mini": { compat: { supportsOpenAIGrammarTools: true } },
  "gpt-5.5": { compat: { supportsOpenAIGrammarTools: true } },
  "gpt-5.6-sol": { compat: { supportsOpenAIGrammarTools: true } },
  "gpt-5.6-terra": { compat: { supportsOpenAIGrammarTools: true } },
  "gpt-5.6-luna": { compat: { supportsOpenAIGrammarTools: true } },
};
