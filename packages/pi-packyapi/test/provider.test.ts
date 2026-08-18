import assert from "node:assert/strict";
import test from "node:test";
import mapping from "../catalog/model-mapping.json" with { type: "json" };
import extension, { createPackyAPIProvider, PACKYAPI_MODELS } from "../extensions/index.ts";

const supportedIds = mapping.models.map(({ id }) => id);

test("provider exposes every explicitly mapped model with endpoint-selected APIs", () => {
  assert.deepEqual(
    PACKYAPI_MODELS.map((model) => model.id),
    supportedIds,
  );
  assert.equal(PACKYAPI_MODELS.length, 14);
  for (const model of PACKYAPI_MODELS) {
    assert.equal(model.provider, "packyapi");
    assert.equal("quotaCost" in model, false);
    assert.ok(model.cost.input >= 0);
    assert.equal(
      model.baseUrl,
      model.api === "anthropic-messages" ? "https://cf.api.fan" : "https://cf.api.fan/v1",
    );
    assert.ok(["openai-responses", "anthropic-messages", "openai-completions"].includes(model.api));
    if (model.api === "openai-responses") {
      assert.equal(model.headers?.["user-agent"], "codex_exec");
    } else if (model.api === "anthropic-messages") {
      assert.equal(model.headers?.["user-agent"], "claude-cli/2.1.75");
      assert.equal(model.headers?.["x-app"], "cli");
    } else {
      assert.equal(model.headers?.["user-agent"], undefined);
    }
  }
  assert.equal(PACKYAPI_MODELS.find(({ id }) => id === "kimi-k3")?.api, "anthropic-messages");
  assert.equal(PACKYAPI_MODELS.find(({ id }) => id === "MiniMax-M3")?.api, "openai-completions");
  assert.equal(PACKYAPI_MODELS.find(({ id }) => id === "gpt-5.5")?.api, "openai-responses");
  assert.deepEqual(PACKYAPI_MODELS.find(({ id }) => id === "kimi-k3")?.input, ["text", "image"]);
  assert.equal(
    PACKYAPI_MODELS.find(({ id }) => id === "gpt-5.6-sol")?.thinkingLevelMap?.max,
    "max",
  );
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

test("extension registers the mixed-API Provider object", () => {
  let registered: unknown;
  extension({
    registerProvider(provider: unknown) {
      registered = provider;
    },
  } as never);
  assert.equal((registered as { id?: string })?.id, "packyapi");
  assert.equal(typeof (registered as { stream?: unknown })?.stream, "function");
});
