import type {
  Api,
  Context,
  Model,
  ProviderStreams,
  SimpleStreamOptions,
  StreamOptions,
} from "@earendil-works/pi-ai";
import {
  anthropicMessagesApi,
  createProvider,
  envApiKeyAuth,
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PACKYAPI_BASE_URL, PACKYAPI_MODELS, PACKYAPI_PROVIDER_ID } from "./models.js";

function hasUnsupportedLookaround(pattern: string): boolean {
  let escaped = false;
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (!inClass && char === "(" && pattern[index + 1] === "?") {
      const suffix = pattern.slice(index + 2, index + 4);
      if (suffix[0] === "=" || suffix[0] === "!" || suffix === "<=" || suffix === "<!") {
        return true;
      }
    }
  }
  return false;
}

/** Copy-on-write removal of regex constraints unsupported by PackyAPI. */
export function sanitizePackyAPIPayload<T>(payload: T): T {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) {
    let changed = false;
    const sanitized = payload.map((value) => {
      const next = sanitizePackyAPIPayload(value);
      if (next !== value) changed = true;
      return next;
    });
    return (changed ? sanitized : payload) as T;
  }
  const record = payload as Record<string, unknown>;
  const removePattern =
    typeof record.pattern === "string" && hasUnsupportedLookaround(record.pattern);
  let copy: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(record)) {
    if (key === "pattern" && removePattern) continue;
    const next = sanitizePackyAPIPayload(value);
    if (next !== value) {
      copy ??= { ...record };
      copy[key] = next;
    }
  }
  if (removePattern) {
    copy ??= { ...record };
    delete copy.pattern;
  }
  return (copy ?? payload) as T;
}

function packyResponsesApi() {
  const responses = openAIResponsesApi();
  const sanitizeOptions = <T extends StreamOptions | SimpleStreamOptions | undefined>(
    options: T,
  ) => ({
    ...options,
    onPayload: async (payload: unknown, model: Model<Api>) => {
      const transformed = await options?.onPayload?.(payload, model);
      return sanitizePackyAPIPayload(transformed ?? payload);
    },
  });
  return {
    stream: (model: Model<Api>, context: Context, options?: StreamOptions) =>
      responses.stream(model, context, sanitizeOptions(options)),
    streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
      responses.streamSimple(model, context, sanitizeOptions(options)),
  } satisfies ProviderStreams;
}

export {
  PACKYAPI_APIS,
  PACKYAPI_BASE_URL,
  PACKYAPI_MODELS,
  PACKYAPI_ORIGIN,
  PACKYAPI_PROVIDER_ID,
} from "./models.js";

export function createPackyAPIProvider() {
  return createProvider({
    id: PACKYAPI_PROVIDER_ID,
    name: "PackyAPI",
    baseUrl: PACKYAPI_BASE_URL,
    auth: { apiKey: envApiKeyAuth("PackyAPI API key", ["PACKYAPI_API_KEY"]) },
    models: PACKYAPI_MODELS,
    api: {
      "openai-responses": packyResponsesApi(),
      "anthropic-messages": anthropicMessagesApi(),
      "openai-completions": openAICompletionsApi(),
    },
  });
}

export default function packyAPIExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createPackyAPIProvider());
}
