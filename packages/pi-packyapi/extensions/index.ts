import { createProvider, envApiKeyAuth, stream, streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PACKYAPI_API,
  PACKYAPI_BASE_URL,
  PACKYAPI_MODELS,
  PACKYAPI_PROVIDER_ID,
} from "./models.js";

export {
  PACKYAPI_API,
  PACKYAPI_BASE_URL,
  PACKYAPI_MODELS,
  PACKYAPI_PROVIDER_ID,
} from "./models.js";

export function createPackyAPIProvider() {
  return createProvider({
    id: PACKYAPI_PROVIDER_ID,
    name: "PackyAPI",
    baseUrl: PACKYAPI_BASE_URL,
    auth: { apiKey: envApiKeyAuth("PackyAPI API key", ["PACKYAPI_API_KEY"]) },
    models: PACKYAPI_MODELS,
    api: { [PACKYAPI_API]: { stream, streamSimple } },
  });
}

export default function packyAPIExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createPackyAPIProvider());
}
