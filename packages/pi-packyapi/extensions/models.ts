import type { Model } from "@earendil-works/pi-ai";
import catalog from "../catalog/models.json" with { type: "json" };
import { PACKYAPI_MODEL_OVERRIDES } from "./overrides.js";

export const PACKYAPI_PROVIDER_ID = "packyapi";
export const PACKYAPI_BASE_URL = "https://cf.api.fan/v1";
export const PACKYAPI_API = "openai-responses" as const;

function assembleModels(): readonly Model<typeof PACKYAPI_API>[] {
  const catalogIds = new Set(catalog.models.map(({ id }) => id));
  const extraOverrides = Object.keys(PACKYAPI_MODEL_OVERRIDES).filter((id) => !catalogIds.has(id));
  if (extraOverrides.length > 0) {
    throw new Error(
      `PackyAPI capability overrides have no catalog entry: ${extraOverrides.join(", ")}`,
    );
  }

  return catalog.models.map(({ id, cost }) => {
    const override = PACKYAPI_MODEL_OVERRIDES[id];
    if (!override) throw new Error(`PackyAPI catalog model has no capability override: ${id}`);
    return {
      id,
      api: PACKYAPI_API,
      provider: PACKYAPI_PROVIDER_ID,
      baseUrl: PACKYAPI_BASE_URL,
      headers: { "user-agent": "codex_exec" },
      cost,
      ...override,
    };
  });
}

export const PACKYAPI_MODELS = assembleModels();
