import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { typesafeProvider, TYPESAFE_BASE_URL, type EvaluateOptions } from "@geminixiang/jev";

export type JevAuthRegistry = Pick<
  ExtensionContext["modelRegistry"],
  "getProvider" | "getProviderAuth"
>;

type PiProvider = NonNullable<ReturnType<JevAuthRegistry["getProvider"]>>;

/** Auth-only provider: Jev is a decision API, not a Pi chat model. */
export function typesafeLoginProvider() {
  const jev = typesafeProvider();
  const unsupported = (): never => {
    throw new Error("TypeSafe is a decision provider. Use the jev tool, not a chat model.");
  };
  return {
    id: jev.id,
    name: jev.name,
    baseUrl: TYPESAFE_BASE_URL,
    // Jev's newer auth helpers require cancellation signals; Pi 0.82 does not
    // supply them yet. Preserve newer runtimes' signals and bridge older ones.
    auth: {
      apiKey: {
        ...jev.auth.apiKey!,
        login: (interaction) =>
          jev.auth.apiKey!.login!({
            ...interaction,
            signal:
              (interaction as { signal?: AbortSignal }).signal ?? new AbortController().signal,
          }),
        resolve: (context) =>
          jev.auth.apiKey!.resolve({
            ...context,
            signal: (context as { signal?: AbortSignal }).signal ?? new AbortController().signal,
          }),
      },
    },
    getModels: () => [],
    stream: unsupported,
    streamSimple: unsupported,
  } satisfies PiProvider;
}

// These are service identities, not aliases for the active conversation model.
// Cloudflare AI Gateway is deliberately excluded: its gateway token is not a
// Workers AI bearer token. Chat endpoint paths also differ from Jev's endpoints.
const PI_PROVIDERS = {
  typesafe: { id: "typesafe", baseUrls: [TYPESAFE_BASE_URL] },
  openrouter: { id: "openrouter", baseUrls: ["https://openrouter.ai/api/v1"] },
  vercel: {
    id: "vercel-ai-gateway",
    baseUrls: ["https://ai-gateway.vercel.sh", "https://ai-gateway.vercel.sh/v1"],
  },
  cloudflare: { id: "cloudflare-workers-ai", baseUrls: [] },
} as const;

/** Only reuse bearer keys for the standard service endpoints. Never guess a proxy route. */
export async function resolvePiAuth(
  registry: JevAuthRegistry,
  providerId: string,
): Promise<EvaluateOptions | undefined> {
  if (!Object.hasOwn(PI_PROVIDERS, providerId)) return undefined;
  const mapping = PI_PROVIDERS[providerId as keyof typeof PI_PROVIDERS];
  const provider = registry.getProvider(mapping.id);
  if (!provider) return undefined;
  const isStandard = (url: string | undefined) =>
    url === undefined || (mapping.baseUrls as readonly string[]).includes(url.replace(/\/+$/, ""));
  // Do not resolve credentials for an explicitly redirected provider.
  if (!isStandard(provider.baseUrl) || Object.keys(provider.headers ?? {}).length) return undefined;
  let result;
  try {
    result = await registry.getProviderAuth(mapping.id);
  } catch {
    // Auth command/refresh errors can contain secrets. Do not expose them to the LLM
    // or silently charge a different backend when configured Pi auth is broken.
    throw new Error(`Pi authentication failed for ${mapping.id}. Check /login ${mapping.id}.`);
  }
  if (
    !result?.auth.apiKey ||
    !isStandard(result.auth.baseUrl) ||
    Object.keys(result.auth.headers ?? {}).length
  )
    return undefined;

  if (providerId === "cloudflare") {
    const account = result.env?.CLOUDFLARE_ACCOUNT_ID;
    // The SDK substitutes this into the URL without encoding it.
    if (!account || !/^[a-zA-Z0-9_-]+$/.test(account)) return undefined;
    return { apiKey: result.auth.apiKey, env: { CLOUDFLARE_ACCOUNT_ID: account } };
  }
  // Do not leak unrelated provider env (or chat-only headers) into a decision request.
  return { apiKey: result.auth.apiKey };
}
