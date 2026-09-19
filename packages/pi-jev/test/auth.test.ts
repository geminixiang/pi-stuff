import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCredentialStore, type AuthResult } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  ModelRegistry,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createBuiltinJevModels } from "@geminixiang/jev";
import jevExtension, { resolveModel } from "../extensions/index.ts";
import { resolvePiAuth, typesafeLoginProvider, type JevAuthRegistry } from "../extensions/auth.ts";

const emptyEnv = { env: async () => undefined, fileExists: async () => false };
function registry(auth: AuthResult | undefined, baseUrl?: string) {
  const calls: string[] = [];
  const value: JevAuthRegistry = {
    getProvider: (id) => ({ ...typesafeLoginProvider(), id, baseUrl }),
    getProviderAuth: async (id) => {
      calls.push(id);
      return auth;
    },
  };
  return { value, calls };
}

test("maps only matching services and forwards only key plus Workers account", async () => {
  for (const [jev, pi] of Object.entries({
    typesafe: "typesafe",
    openrouter: "openrouter",
    vercel: "vercel-ai-gateway",
    cloudflare: "cloudflare-workers-ai",
  })) {
    const r = registry({
      auth: { apiKey: "pi-key" },
      env: { CLOUDFLARE_ACCOUNT_ID: "account-1", PRIVATE: "unused" },
    });
    assert.deepEqual(
      await resolvePiAuth(r.value, jev),
      jev === "cloudflare"
        ? { apiKey: "pi-key", env: { CLOUDFLARE_ACCOUNT_ID: "account-1" } }
        : { apiKey: "pi-key" },
    );
    assert.deepEqual(r.calls, [pi]);
  }
  const r = registry({ auth: { apiKey: "wrong-key" } });
  for (const id of ["openai", "openai-codex", "cloudflare-ai-gateway", "toString"]) {
    assert.equal(await resolvePiAuth(r.value, id), undefined);
  }
  assert.deepEqual(r.calls, []);
});

test("does not forward redirected, header-based, or incomplete auth", async () => {
  for (const auth of [
    undefined,
    { auth: {} },
    { auth: { apiKey: "k", baseUrl: "https://proxy.example" } },
    { auth: { apiKey: "k", headers: { Authorization: "other" } } },
  ]) {
    assert.equal(await resolvePiAuth(registry(auth).value, "openrouter"), undefined);
  }
  const redirected = registry({ auth: { apiKey: "k" } }, "https://proxy.example");
  assert.equal(await resolvePiAuth(redirected.value, "openrouter"), undefined);
  assert.deepEqual(redirected.calls, []);
  for (const account of [undefined, "", "../other?query"]) {
    assert.equal(
      await resolvePiAuth(
        registry({
          auth: { apiKey: "k" },
          env: account === undefined ? {} : { CLOUDFLARE_ACCOUNT_ID: account },
        }).value,
        "cloudflare",
      ),
      undefined,
    );
  }
});

test("keeps provider order, prefers Pi within a backend, retains env fallback and forced selection", async () => {
  const models = createBuiltinJevModels({
    authContext: {
      ...emptyEnv,
      env: async (name) => (name === "TYPESAFE_API_KEY" ? "env-key" : undefined),
    },
  });
  const r = registry({ auth: { apiKey: "pi-key" } });
  const selected = await resolveModel(models, undefined, r.value);
  assert.equal(selected.model.provider, "typesafe");
  assert.equal(selected.options?.apiKey, "pi-key");
  const fallback = await resolveModel(models, undefined, registry(undefined).value);
  assert.equal(fallback.model.provider, "typesafe");
  assert.equal(fallback.options, undefined);
  assert.equal((await resolveModel(models, "vercel", r.value)).model.provider, "vercel");
  await assert.rejects(resolveModel(models, "unknown", r.value), /No configured Jev backend/);
});

test("auth errors surface without exposing credential errors or trying another backend", async () => {
  const r = registry(undefined);
  r.value.getProviderAuth = async () => {
    throw new Error("secret provider diagnostic");
  };
  await assert.rejects(
    resolveModel(createBuiltinJevModels({ authContext: emptyEnv }), undefined, r.value),
    (err: Error) => !err.message.includes("secret") && /Pi authentication/.test(err.message),
  );
});

test("native TypeSafe login persists through Pi runtime without chat models; resolves changes", async () => {
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
  runtime.registerNativeProvider(typesafeLoginProvider());
  const registry = new ModelRegistry(runtime);
  const provider = registry.getProvider("typesafe")!;
  assert.ok(provider.auth.apiKey?.login);
  assert.equal(provider.auth.oauth, undefined);
  assert.deepEqual(provider.getModels(), []);
  await runtime.login("typesafe", "api_key", {
    prompt: async (prompt) => {
      assert.equal(prompt.type, "secret");
      return "saved-key";
    },
    notify: () => {},
  });
  assert.deepEqual(await credentials.read("typesafe"), { type: "api_key", key: "saved-key" });
  assert.equal((await resolvePiAuth(registry, "typesafe"))?.apiKey, "saved-key");
  await runtime.setRuntimeApiKey("typesafe", "runtime-key");
  assert.equal((await resolvePiAuth(registry, "typesafe"))?.apiKey, "runtime-key");
  await runtime.removeRuntimeApiKey("typesafe");
  await runtime.logout("typesafe");
  assert.equal(await credentials.read("typesafe"), undefined);
});

test("tool uses execution context credentials on the actual SDK request and preserves cancellation", async (t) => {
  let tool: ToolDefinition;
  let registered = false;
  jevExtension({
    registerProvider: (provider: ReturnType<typeof typesafeLoginProvider>) => {
      registered = provider.id === "typesafe";
    },
    registerTool: (definition: ToolDefinition) => {
      tool = definition;
    },
  } as ExtensionAPI);
  assert.ok(registered);
  const controller = new AbortController();
  let count = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer key-${++count}`);
    assert.ok(init.signal);
    if (count === 3) {
      controller.abort();
      assert.equal(init.signal.aborted, true);
      throw init.signal.reason;
    }
    assert.equal(JSON.parse(String(init.body)).questions.q.type, "noul");
    return Response.json({ answers: { q: { type: "noul", noul: 0.8 } } });
  });
  for (let i = 1; i <= 2; i++) {
    const ctx = {
      modelRegistry: registry({ auth: { apiKey: `key-${i}` } }).value,
    } as ExtensionContext;
    const result = await tool!.execute(
      "id",
      {
        label: "test",
        state: "state",
        questions: { q: { type: "boolean", instructions: "yes?" } },
        provider: "typesafe",
      },
      controller.signal,
      undefined,
      ctx,
    );
    assert.ok(!JSON.stringify(result).includes(`key-${i}`));
  }
  await assert.rejects(
    tool!.execute(
      "abort",
      {
        label: "test",
        state: "state",
        questions: { q: { type: "boolean", instructions: "yes?" } },
        provider: "typesafe",
      },
      controller.signal,
      undefined,
      { modelRegistry: registry({ auth: { apiKey: "key-3" } }).value } as ExtensionContext,
    ),
    /aborted/,
  );
});

test("all legacy Jev environment backends remain selectable", async () => {
  for (const [provider, env] of [
    ["typesafe", { TYPESAFE_API_KEY: "env" }],
    ["openrouter", { OPENROUTER_API_KEY: "env" }],
    ["vercel", { AI_GATEWAY_API_KEY: "env" }],
    ["vercel", { VERCEL_API_KEY: "env" }],
    ["cloudflare", { CLOUDFLARE_API_TOKEN: "env", CLOUDFLARE_ACCOUNT_ID: "account" }],
  ] as [string, Record<string, string>][]) {
    const models = createBuiltinJevModels({
      authContext: { ...emptyEnv, env: async (name) => env[name] },
    });
    const selected = await resolveModel(models, provider, registry(undefined).value);
    assert.equal(selected.model.provider, provider);
    assert.equal(selected.options, undefined);
  }
});

test("Pi Vercel and Workers auth reaches Jev-specific wire endpoints", async () => {
  for (const provider of ["vercel", "cloudflare"]) {
    const models = createBuiltinJevModels({
      authContext: emptyEnv,
      fetch: async (url, init) => {
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer pi-key");
        if (provider === "vercel") {
          assert.equal(url, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
          return Response.json({ answers: { q: { type: "boolean", probability: 0.9 } } });
        }
        assert.equal(url, "https://api.cloudflare.com/client/v4/accounts/account-1/ai/run");
        return Response.json({
          success: true,
          result: { result: { answers: { q: { type: "noul", noul: 0.9 } } } },
        });
      },
    });
    const { model, options } = await resolveModel(
      models,
      provider,
      registry({ auth: { apiKey: "pi-key" }, env: { CLOUDFLARE_ACCOUNT_ID: "account-1" } }).value,
    );
    await models.evaluate(model, { state: "state", questions: { q: { type: "noul" } } }, options);
  }
});
