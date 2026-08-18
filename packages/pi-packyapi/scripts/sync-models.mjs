#!/usr/bin/env node
import { syncCatalog } from "./model-catalog.mjs";

try {
  const catalog = await syncCatalog();
  console.log(`Updated catalog/models.json with ${catalog.models.length} curated models.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "PackyAPI catalog sync failed.");
  process.exitCode = 1;
}
