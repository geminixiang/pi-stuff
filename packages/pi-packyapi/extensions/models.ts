import type { Api, Model } from "@earendil-works/pi-ai";
import catalog from "../catalog/models.json" with { type: "json" };
import { PACKYAPI_MODEL_EXCEPTIONS } from "./overrides.js";

export const PACKYAPI_PROVIDER_ID = "packyapi";
export const PACKYAPI_ORIGIN = "https://cf.api.fan";
export const PACKYAPI_BASE_URL = `${PACKYAPI_ORIGIN}/v1`;
export const PACKYAPI_APIS = [
  "openai-responses",
  "anthropic-messages",
  "openai-completions",
] as const;

function assembleModels(): readonly Model<Api>[] {
  const catalogIds = new Set(catalog.models.map(({ id }) => id));
  const extras = Object.keys(PACKYAPI_MODEL_EXCEPTIONS).filter((id) => !catalogIds.has(id));
  if (extras.length > 0)
    throw new Error(`PackyAPI exceptions have no catalog entry: ${extras.join(", ")}`);

  return catalog.models.map(({ id, api, cost, capability }) => {
    const exception = PACKYAPI_MODEL_EXCEPTIONS[id] ?? {};
    return {
      id,
      api,
      provider: PACKYAPI_PROVIDER_ID,
      baseUrl: api === "anthropic-messages" ? PACKYAPI_ORIGIN : PACKYAPI_BASE_URL,
      ...(api === "openai-responses"
        ? { headers: { "user-agent": "codex_exec" } }
        : api === "anthropic-messages"
          ? {
              headers: {
                "anthropic-beta": "claude-code-20250219",
                "user-agent": "claude-cli/2.1.75",
                "x-app": "cli",
              },
            }
          : {}),
      cost,
      ...capability,
      ...exception,
    } as Model<Api>;
  });
}

export const PACKYAPI_MODELS = assembleModels();
