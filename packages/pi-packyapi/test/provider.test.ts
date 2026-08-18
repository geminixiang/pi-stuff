import assert from "node:assert/strict";
import test from "node:test";
import extension, { createPackyAPIProvider, PACKYAPI_MODELS } from "../extensions/index.ts";

test("catalog contains exactly the curated PackyAPI Responses models", () => {
  assert.deepEqual(
    PACKYAPI_MODELS.map((model) => model.id),
    ["deepseek-v4-flash", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  );
  for (const model of PACKYAPI_MODELS) {
    assert.equal(model.provider, "packyapi");
    assert.equal(model.baseUrl, "https://cf.api.fan/v1");
    assert.equal(model.api, "openai-responses");
    assert.equal(model.headers?.["user-agent"], "codex_exec");
  }
  assert.deepEqual(
    PACKYAPI_MODELS.map((model) => model.cost),
    [
      { input: 1.5, output: 4.5, cacheRead: 0.04995, cacheWrite: 0 },
      { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
      { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
      { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 0 },
    ],
  );
  assert.deepEqual(PACKYAPI_MODELS[0]?.input, ["text"]);
  for (const model of PACKYAPI_MODELS.slice(1)) {
    assert.deepEqual(model.input, ["text", "image"]);
    assert.equal(model.compat?.supportsOpenAIGrammarTools, true);
    assert.equal(model.thinkingLevelMap?.off, null);
    assert.equal(model.thinkingLevelMap?.max, "max");
  }
});

test("provider offers interactive login and environment auth", async () => {
  const provider = createPackyAPIProvider();
  assert.equal(provider.id, "packyapi");
  assert.equal(provider.name, "PackyAPI");
  assert.equal(typeof provider.auth.apiKey?.login, "function");

  const credential = await provider.auth.apiKey?.login?.({
    signal: new AbortController().signal,
    prompt: async (prompt) => {
      assert.match(prompt.message, /PackyAPI API key/);
      return "stored-key";
    },
    notify() {},
  });
  assert.deepEqual(credential, { type: "api_key", key: "stored-key" });

  const previous = process.env.PACKYAPI_API_KEY;
  process.env.PACKYAPI_API_KEY = "environment-key";
  try {
    const auth = await provider.auth.apiKey?.resolve({
      ctx: { env: (name: string) => process.env[name] } as never,
    });
    assert.equal(auth?.auth.apiKey, "environment-key");
  } finally {
    if (previous === undefined) delete process.env.PACKYAPI_API_KEY;
    else process.env.PACKYAPI_API_KEY = previous;
  }
});

test("extension registers the complete Provider object", () => {
  let registered: unknown;
  extension({
    registerProvider(provider: unknown) {
      registered = provider;
    },
  } as never);
  assert.equal((registered as { id?: string })?.id, "packyapi");
  assert.equal(typeof (registered as { stream?: unknown })?.stream, "function");
});
