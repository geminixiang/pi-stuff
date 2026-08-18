import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCatalog,
  checkAuthenticatedVisibility,
  checkCatalog,
  MODELS_URL,
  PRICING_URL,
  serializeCatalog,
  syncCatalog,
} from "../scripts/model-catalog.mjs";

const ids = ["deepseek-v4-flash", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const pricing = {
  data: [
    {
      model_name: "deepseek-v4-flash",
      model_ratio: 0.75,
      completion_ratio: 3,
      cache_ratio: 0.0333,
      supported_endpoint_types: ["anthropic", "openai", "openai-response"],
      enable_groups: ["deepseek-officially"],
    },
    {
      model_name: "gpt-5.6-sol",
      model_ratio: 2.5,
      completion_ratio: 6,
      cache_ratio: 0.1,
      supported_endpoint_types: ["openai-response", "openai"],
      enable_groups: ["hongjing", "azure-officially", "codex"],
    },
    {
      model_name: "gpt-5.6-terra",
      model_ratio: 1,
      completion_ratio: 6,
      cache_ratio: 0.1,
      supported_endpoint_types: ["openai-response", "openai"],
      enable_groups: ["hongjing", "azure-officially", "codex"],
    },
    {
      model_name: "gpt-5.6-luna",
      model_ratio: 0.5,
      completion_ratio: 6,
      cache_ratio: 0.1,
      supported_endpoint_types: ["openai-response"],
      enable_groups: ["codex"],
    },
  ],
};
const expected = buildCatalog(pricing, ids);
const readExpected = async () => serializeCatalog(expected);
const pricingFetch = async (url) => {
  assert.equal(url, PRICING_URL);
  return Response.json(pricing);
};

test("generation preserves curated order and derives PackyAPI base costs", () => {
  assert.deepEqual(
    expected.models.map((model) => model.id),
    ids,
  );
  assert.deepEqual(
    expected.models.map((model) => model.cost),
    [
      { input: 1.5, output: 4.5, cacheRead: 0.04995, cacheWrite: 0 },
      { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
      { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
      { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 0 },
    ],
  );
  assert.deepEqual(expected.models[1].endpoints, ["openai", "openai-response"]);
  assert.deepEqual(expected.models[1].groups, ["azure-officially", "codex", "hongjing"]);
  assert.equal(serializeCatalog(expected), serializeCatalog(expected));
  assert.doesNotMatch(serializeCatalog(expected), /generatedAt/);
});

test("generation rejects missing models, invalid pricing, and missing Responses support", () => {
  assert.throws(() => buildCatalog({ data: pricing.data.slice(1) }, ids), /missing curated model/);
  assert.throws(
    () =>
      buildCatalog(
        {
          data: pricing.data.map((record) =>
            record.model_name === ids[0] ? { ...record, model_ratio: "0.75" } : record,
          ),
        },
        ids,
      ),
    /invalid model_ratio/,
  );
  assert.throws(
    () =>
      buildCatalog(
        {
          data: pricing.data.map((record) =>
            record.model_name === ids[3]
              ? { ...record, supported_endpoint_types: ["openai"] }
              : record,
          ),
        },
        ids,
      ),
    /no longer supports openai-response/,
  );
});

test("sync deterministically writes the expected catalog", async () => {
  const writes = [];
  await syncCatalog({
    fetchImpl: pricingFetch,
    readFileImpl: readExpected,
    writeFileImpl: async (url, value) => writes.push({ url: String(url), value }),
  });
  assert.equal(writes.length, 1);
  assert.match(writes[0].url, /catalog\/models\.json$/);
  assert.equal(writes[0].value, serializeCatalog(expected));
});

test("check detects a stale committed catalog with an actionable message", async () => {
  const stale = structuredClone(expected);
  stale.models[0].cost.input = 99;
  await assert.rejects(
    checkCatalog({ fetchImpl: pricingFetch, readFileImpl: async () => serializeCatalog(stale) }),
    /catalog is stale.*models:sync/s,
  );
  await checkCatalog({ fetchImpl: pricingFetch, readFileImpl: readExpected });
});

test("authenticated check validates every committed ID", async () => {
  let authorization;
  const visible = await checkAuthenticatedVisibility({
    apiKey: "secret-value",
    readFileImpl: readExpected,
    fetchImpl: async (url, init) => {
      assert.equal(url, MODELS_URL);
      authorization = new Headers(init.headers).get("authorization");
      return Response.json({ data: ids.map((id) => ({ id })) });
    },
  });
  assert.equal(authorization, "Bearer secret-value");
  assert.deepEqual(visible, ids);
});

test("authenticated failures are useful and never expose the secret or response", async () => {
  const secret = "never-print-this";
  await assert.rejects(
    checkAuthenticatedVisibility({
      apiKey: secret,
      readFileImpl: readExpected,
      fetchImpl: async () => new Response(`upstream echoed ${secret}`, { status: 401 }),
    }),
    (error) => {
      assert.match(error.message, /visibility check failed/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.doesNotMatch(error.message, /upstream echoed/);
      return true;
    },
  );
  await assert.rejects(
    checkAuthenticatedVisibility({
      apiKey: secret,
      readFileImpl: readExpected,
      fetchImpl: async () => Response.json({ data: ids.slice(1).map((id) => ({ id })) }),
    }),
    /cannot see curated models: deepseek-v4-flash/,
  );
});
