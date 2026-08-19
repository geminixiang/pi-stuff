import assert from "node:assert/strict";
import test from "node:test";
import mapping from "../catalog/model-mapping.json" with { type: "json" };
import {
  buildCatalog,
  checkAuthenticatedVisibility,
  checkCatalog,
  CNY_PER_QUOTA,
  MODELS_DEV_URL,
  MODELS_URL,
  PRICING_URL,
  STATUS_URL,
  TOP_UP_POLICY_URL,
  serializeCatalog,
  syncCatalog,
} from "../scripts/model-catalog.mjs";

const testMapping = {
  schemaVersion: 1,
  source: MODELS_DEV_URL,
  models: [{ id: "model-a", modelsDevProvider: "canonical", modelsDevModel: "upstream-a" }],
  unsupported: [{ id: "codex-auto-review", reason: "No defensible match." }],
};
const pricing = {
  data: [
    {
      model_name: "model-a",
      model_ratio: 2,
      completion_ratio: 3,
      cache_ratio: 0.25,
      cache_creation_ratio_5m: 1.25,
      supported_endpoint_types: ["openai-response", "anthropic"],
      enable_groups: ["b", "a"],
    },
  ],
};
const status = { data: { usd_exchange_rate: 7 } };
const modelsDev = {
  canonical: {
    models: {
      "upstream-a": {
        name: "Upstream A",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        modalities: { input: ["text", "image", "video", "pdf"] },
        limit: { context: 1000, output: 200 },
        cost: { input: 999999, output: 999999 },
      },
    },
  },
};
const expected = buildCatalog(pricing, status, modelsDev, testMapping);
const files = new Map([
  ["model-mapping.json", JSON.stringify(testMapping)],
  ["models.json", serializeCatalog(expected)],
]);
const readExpected = async (url) => files.get(String(url).split("/").pop());
const publicFetch = async (url) => {
  if (url === PRICING_URL) return Response.json(pricing);
  if (url === STATUS_URL) return Response.json(status);
  if (url === MODELS_DEV_URL) return Response.json(modelsDev);
  throw new Error(`Unexpected URL: ${url}`);
};

test("generation separates PackyAPI billing facts from models.dev capabilities", () => {
  assert.deepEqual(expected.models[0].quotaCost, {
    input: 4,
    output: 12,
    cacheRead: 1,
    cacheWrite: 5,
  });
  assert.deepEqual(expected.models[0].cost, {
    input: 0.571428571429,
    output: 1.71428571429,
    cacheRead: 0.142857142857,
    cacheWrite: 0.714285714286,
  });
  assert.deepEqual(expected.billing, { cnyPerQuota: CNY_PER_QUOTA, usdExchangeRate: 7 });
  assert.deepEqual(expected.sources, {
    pricing: PRICING_URL,
    status: STATUS_URL,
    topUpPolicy: TOP_UP_POLICY_URL,
    capabilities: MODELS_DEV_URL,
  });
  assert.equal(expected.models[0].api, "openai-responses");
  assert.deepEqual(expected.models[0].groups, ["a", "b"]);
  assert.deepEqual(expected.models[0].capability.input, ["text", "image"]);
  assert.deepEqual(expected.models[0].capability.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: null,
  });
  assert.equal(expected.models[0].capability.contextWindow, 1000);
  assert.doesNotMatch(serializeCatalog(expected), /generatedAt/);
});

test("models.dev cost cannot affect raw quota or converted USD cost", () => {
  const poisoned = structuredClone(modelsDev);
  poisoned.canonical.models["upstream-a"].cost = {
    input: Number.MAX_VALUE,
    output: -1,
    cache_read: 7,
    cache_write: Number.MAX_VALUE,
  };
  const poisonedModel = buildCatalog(pricing, status, poisoned, testMapping).models[0];
  assert.deepEqual(poisonedModel.quotaCost, expected.models[0].quotaCost);
  assert.deepEqual(poisonedModel.cost, expected.models[0].cost);
  const packyCacheWrite = structuredClone(pricing);
  packyCacheWrite.data[0].cache_creation_ratio_5m = 2;
  const changed = buildCatalog(packyCacheWrite, status, poisoned, testMapping).models[0];
  assert.equal(changed.quotaCost.cacheWrite, 8);
  assert.equal(changed.cost.cacheWrite, 1.14285714286);
});

test("endpoint priority is Responses, completions, then Anthropic", () => {
  const withEndpoints = (endpoints) => ({
    data: [{ ...pricing.data[0], supported_endpoint_types: endpoints }],
  });
  assert.equal(
    buildCatalog(withEndpoints(["anthropic", "openai"]), status, modelsDev, testMapping).models[0]
      .api,
    "openai-completions",
  );
  assert.equal(
    buildCatalog(withEndpoints(["anthropic"]), status, modelsDev, testMapping).models[0].api,
    "anthropic-messages",
  );
  assert.throws(
    () => buildCatalog(withEndpoints(["other"]), status, modelsDev, testMapping),
    /no supported Pi endpoint/,
  );
});

test("explicit mapping is required and missing capabilities fail", () => {
  assert.throws(
    () => buildCatalog({ data: [] }, status, modelsDev, testMapping),
    /missing supported model/,
  );
  assert.throws(() => buildCatalog(pricing, status, {}, testMapping), /missing mapped capability/);
});

test("exchange rate must be finite and positive", () => {
  for (const value of [0, -1, Number.POSITIVE_INFINITY, "7", undefined]) {
    assert.throws(
      () => buildCatalog(pricing, { data: { usd_exchange_rate: value } }, modelsDev, testMapping),
      /invalid usd_exchange_rate/,
    );
  }
  const quotaFivePricing = structuredClone(pricing);
  quotaFivePricing.data[0].model_ratio = 2.5;
  assert.equal(
    buildCatalog(quotaFivePricing, status, modelsDev, testMapping).models[0].cost.input,
    0.714285714286,
  );
});

test("sync deterministically writes combined source metadata", async () => {
  const writes = [];
  await syncCatalog({
    fetchImpl: publicFetch,
    readFileImpl: readExpected,
    writeFileImpl: async (url, value) => writes.push({ url: String(url), value }),
  });
  assert.equal(writes[0].value, serializeCatalog(expected));
  assert.equal(serializeCatalog(expected), serializeCatalog(expected));
});

test("check detects pricing, exchange-rate, and capability drift", async () => {
  await checkCatalog({ fetchImpl: publicFetch, readFileImpl: readExpected });

  const changedStatusFetch = async (url) => {
    if (url === STATUS_URL) return Response.json({ data: { usd_exchange_rate: 6.5 } });
    return publicFetch(url);
  };
  await assert.rejects(
    checkCatalog({ fetchImpl: changedStatusFetch, readFileImpl: readExpected }),
    /catalog is stale.*models:sync/s,
  );

  const stale = structuredClone(expected);
  stale.models[0].capability.contextWindow = 9;
  const staleRead = async (url) =>
    String(url).endsWith("models.json") ? serializeCatalog(stale) : JSON.stringify(testMapping);
  await assert.rejects(
    checkCatalog({ fetchImpl: publicFetch, readFileImpl: staleRead }),
    /catalog is stale.*models:sync/s,
  );
});

test("authenticated visibility reports known unsupported extras without failing", async () => {
  const committed = { ...expected, models: mapping.models.map(({ id }) => ({ id })) };
  const authRead = async (url) =>
    String(url).endsWith("models.json") ? JSON.stringify(committed) : JSON.stringify(mapping);
  const result = await checkAuthenticatedVisibility({
    apiKey: "secret-value",
    readFileImpl: authRead,
    fetchImpl: async (url, init) => {
      assert.equal(url, MODELS_URL);
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer secret-value");
      return Response.json({
        data: [
          ...mapping.models.map(({ id }) => ({ id })),
          { id: "codex-auto-review" },
          { id: "claude-fable-5" },
          { id: "newly-added-model" },
        ],
      });
    },
  });
  assert.deepEqual(
    result.supported,
    mapping.models.map(({ id }) => id),
  );
  assert.deepEqual(result.extraVisible, [
    "claude-fable-5",
    "codex-auto-review",
    "newly-added-model",
  ]);
});

test("authenticated failures never expose secrets or responses", async () => {
  const secret = "never-print-this";
  await assert.rejects(
    checkAuthenticatedVisibility({
      apiKey: secret,
      readFileImpl: readExpected,
      fetchImpl: async () => new Response(`echo ${secret}`, { status: 401 }),
    }),
    (error) => {
      assert.match(error.message, /visibility check failed/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});
