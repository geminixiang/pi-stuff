import { readFile, writeFile } from "node:fs/promises";

export const PRICING_URL = "https://www.packyapi.com/api/pricing";
export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_URL = "https://cf.api.fan/v1/models";
export const CATALOG_URL = new URL("../catalog/models.json", import.meta.url);
export const MAPPING_URL = new URL("../catalog/model-mapping.json", import.meta.url);

async function readJson(url, readFileImpl) {
  return JSON.parse(await readFileImpl(url, "utf8"));
}

export async function readCatalog({ readFileImpl = readFile } = {}) {
  return readJson(CATALOG_URL, readFileImpl);
}

export async function readMapping({ readFileImpl = readFile } = {}) {
  return readJson(MAPPING_URL, readFileImpl);
}

function records(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return data.filter((record) => record && typeof record === "object");
}

function finiteNumber(value, field, id) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Pricing data for ${id} has invalid ${field}.`);
  }
  return value;
}

function stableNumber(value) {
  return Number(value.toPrecision(12));
}

function selectApi(endpoints, id) {
  if (endpoints.includes("openai-response")) return "openai-responses";
  if (endpoints.includes("openai")) return "openai-completions";
  if (endpoints.includes("anthropic")) return "anthropic-messages";
  throw new Error(`PackyAPI model has no supported Pi endpoint: ${id}`);
}

const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function capability(record, id) {
  const name = record?.name;
  const contextWindow = record?.limit?.context;
  const maxTokens = record?.limit?.output;
  const inputs = record?.modalities?.input;
  if (typeof name !== "string" || typeof record?.reasoning !== "boolean") {
    throw new Error(`models.dev capability data for ${id} is incomplete.`);
  }
  if (!Number.isFinite(contextWindow) || !Number.isFinite(maxTokens) || !Array.isArray(inputs)) {
    throw new Error(`models.dev capability limits or modalities for ${id} are invalid.`);
  }
  const input = [...new Set(inputs.filter((value) => value === "text" || value === "image"))];
  if (!input.includes("text"))
    throw new Error(`models.dev model does not support text input: ${id}`);

  const thinkingLevelMap = Object.fromEntries(PI_LEVELS.map((level) => [level, null]));
  for (const option of Array.isArray(record.reasoning_options) ? record.reasoning_options : []) {
    if (option?.type === "effort" && Array.isArray(option.values)) {
      for (const level of PI_LEVELS) {
        if (level !== "off" && option.values.includes(level)) thinkingLevelMap[level] = level;
      }
    }
  }

  return {
    name,
    reasoning: record.reasoning,
    input,
    contextWindow,
    maxTokens,
    ...(record.reasoning ? { thinkingLevelMap } : {}),
  };
}

export function buildCatalog(pricingPayload, modelsDevPayload, mapping) {
  if (
    mapping?.schemaVersion !== 1 ||
    mapping?.source !== MODELS_DEV_URL ||
    !Array.isArray(mapping.models)
  ) {
    throw new Error("Committed model mapping has an unsupported schema or source URL.");
  }
  const pricingById = new Map(records(pricingPayload).map((record) => [record.model_name, record]));
  const models = mapping.models.map(({ id, modelsDevProvider, modelsDevModel }) => {
    const price = pricingById.get(id);
    if (!price) throw new Error(`Public pricing data is missing supported model: ${id}`);
    const endpoints = price.supported_endpoint_types;
    const groups = price.enable_groups;
    if (!Array.isArray(endpoints) || !endpoints.every((value) => typeof value === "string")) {
      throw new Error(`Pricing data for ${id} has invalid supported_endpoint_types.`);
    }
    if (!Array.isArray(groups) || !groups.every((value) => typeof value === "string")) {
      throw new Error(`Pricing data for ${id} has invalid enable_groups.`);
    }
    const candidate = modelsDevPayload?.[modelsDevProvider]?.models?.[modelsDevModel];
    if (!candidate)
      throw new Error(
        `models.dev is missing mapped capability: ${modelsDevProvider}/${modelsDevModel}`,
      );
    const modelRatio = finiteNumber(price.model_ratio, "model_ratio", id);
    const completionRatio = finiteNumber(price.completion_ratio, "completion_ratio", id);
    const cacheRatio = finiteNumber(price.cache_ratio, "cache_ratio", id);
    const cacheCreationRatio =
      price.cache_creation_ratio_5m == null
        ? 0
        : finiteNumber(price.cache_creation_ratio_5m, "cache_creation_ratio_5m", id);
    const inputCost = modelRatio * 2;
    return {
      id,
      modelsDevProvider,
      modelsDevModel,
      api: selectApi(endpoints, id),
      cost: {
        input: stableNumber(inputCost),
        output: stableNumber(inputCost * completionRatio),
        cacheRead: stableNumber(inputCost * cacheRatio),
        cacheWrite: stableNumber(inputCost * cacheCreationRatio),
      },
      endpoints: [...endpoints].sort(),
      groups: [...groups].sort(),
      capability: capability(candidate, id),
    };
  });
  return {
    schemaVersion: 2,
    sources: { pricing: PRICING_URL, capabilities: MODELS_DEV_URL },
    models,
  };
}

export function serializeCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

async function fetchJson(fetchImpl, url, label) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

export async function expectedCatalog({ fetchImpl = fetch, readFileImpl = readFile } = {}) {
  const mapping = await readMapping({ readFileImpl });
  const [pricing, modelsDev] = await Promise.all([
    fetchJson(fetchImpl, PRICING_URL, "Public pricing endpoint"),
    fetchJson(fetchImpl, MODELS_DEV_URL, "models.dev endpoint"),
  ]);
  return buildCatalog(pricing, modelsDev, mapping);
}

export async function syncCatalog({
  fetchImpl = fetch,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
} = {}) {
  const expected = await expectedCatalog({ fetchImpl, readFileImpl });
  await writeFileImpl(CATALOG_URL, serializeCatalog(expected));
  return expected;
}

export async function checkCatalog({ fetchImpl = fetch, readFileImpl = readFile } = {}) {
  const committed = await readCatalog({ readFileImpl });
  const expected = await expectedCatalog({ fetchImpl, readFileImpl });
  if (JSON.stringify(committed) !== JSON.stringify(expected)) {
    throw new Error(
      "Committed PackyAPI catalog is stale. Run `npm run models:sync --workspace @geminixiang/pi-packyapi` and review the diff.",
    );
  }
  return expected;
}

export async function checkAuthenticatedVisibility({
  apiKey,
  fetchImpl = fetch,
  readFileImpl = readFile,
} = {}) {
  if (!apiKey) throw new Error("PACKYAPI_API_KEY is required for models:check-auth.");
  const committed = await readCatalog({ readFileImpl });
  let payload;
  try {
    const response = await fetchImpl(MODELS_URL, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error("request failed");
    payload = await response.json();
  } catch {
    throw new Error("Authenticated PackyAPI model visibility check failed.");
  }
  const visible = new Set(
    records(payload)
      .map((record) => record.id)
      .filter((id) => typeof id === "string"),
  );
  const supported = committed.models.map((model) => model.id);
  const missing = supported.filter((id) => !visible.has(id));
  if (missing.length > 0)
    throw new Error(`Authenticated token cannot see supported models: ${missing.join(", ")}`);
  const extraVisible = [...visible].filter((id) => !supported.includes(id)).sort();
  return { supported, extraVisible };
}
