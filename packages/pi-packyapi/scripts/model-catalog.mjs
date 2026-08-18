import { readFile, writeFile } from "node:fs/promises";

export const PRICING_URL = "https://www.packyapi.com/api/pricing";
export const MODELS_URL = "https://cf.api.fan/v1/models";
export const CATALOG_URL = new URL("../catalog/models.json", import.meta.url);

export async function readCatalog({ readFileImpl = readFile } = {}) {
  return JSON.parse(await readFileImpl(CATALOG_URL, "utf8"));
}

function pricingRecords(payload) {
  const records = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload)
      ? payload
      : [];
  return records.filter((record) => record && typeof record === "object");
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

export function buildCatalog(payload, curatedIds) {
  const byId = new Map(pricingRecords(payload).map((record) => [record.model_name, record]));
  const models = curatedIds.map((id) => {
    const record = byId.get(id);
    if (!record) throw new Error(`Public pricing data is missing curated model: ${id}`);
    const endpoints = record.supported_endpoint_types;
    const groups = record.enable_groups;
    if (!Array.isArray(endpoints) || !endpoints.every((value) => typeof value === "string")) {
      throw new Error(`Pricing data for ${id} has invalid supported_endpoint_types.`);
    }
    if (!endpoints.includes("openai-response")) {
      throw new Error(`Curated model no longer supports openai-response: ${id}`);
    }
    if (!Array.isArray(groups) || !groups.every((value) => typeof value === "string")) {
      throw new Error(`Pricing data for ${id} has invalid enable_groups.`);
    }
    const modelRatio = finiteNumber(record.model_ratio, "model_ratio", id);
    const completionRatio = finiteNumber(record.completion_ratio, "completion_ratio", id);
    const cacheRatio = finiteNumber(record.cache_ratio, "cache_ratio", id);
    const input = modelRatio * 2;
    return {
      id,
      cost: {
        input: stableNumber(input),
        output: stableNumber(input * completionRatio),
        cacheRead: stableNumber(input * cacheRatio),
        cacheWrite: 0,
      },
      endpoints: [...endpoints].sort(),
      groups: [...groups].sort(),
    };
  });
  return { schemaVersion: 1, source: PRICING_URL, models };
}

export function serializeCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2).replace(
    /^(\s*)"(endpoints|groups)": \[\n((?:\1  "[^"]+",?\n)+)\1\]/gm,
    (_match, indent, key, values) => {
      const items = [...values.matchAll(/"([^"]+)"/g)].map((match) => JSON.stringify(match[1]));
      return `${indent}"${key}": [${items.join(", ")}]`;
    },
  )}\n`;
}

async function fetchJson(fetchImpl, url, init, label) {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  return response.json();
}

export async function expectedCatalog({ fetchImpl = fetch, readFileImpl = readFile } = {}) {
  const committed = await readCatalog({ readFileImpl });
  if (
    committed.schemaVersion !== 1 ||
    committed.source !== PRICING_URL ||
    !Array.isArray(committed.models)
  ) {
    throw new Error("Committed PackyAPI catalog has an unsupported schema or source URL.");
  }
  const ids = committed.models.map((model) => model.id);
  const payload = await fetchJson(fetchImpl, PRICING_URL, undefined, "Public pricing endpoint");
  return buildCatalog(payload, ids);
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
  if (serializeCatalog(committed) !== serializeCatalog(expected)) {
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
    payload = await fetchJson(
      fetchImpl,
      MODELS_URL,
      { headers: { authorization: `Bearer ${apiKey}` } },
      "Authenticated models endpoint",
    );
  } catch {
    throw new Error("Authenticated PackyAPI model visibility check failed.");
  }
  const records = Array.isArray(payload?.data) ? payload.data : [];
  const visible = new Set(
    records.map((record) => record?.id).filter((id) => typeof id === "string"),
  );
  const missing = committed.models.map((model) => model.id).filter((id) => !visible.has(id));
  if (missing.length > 0) {
    throw new Error(`Authenticated token cannot see curated models: ${missing.join(", ")}`);
  }
  return committed.models.map((model) => model.id);
}
