#!/usr/bin/env node
import { checkCatalog } from "./model-catalog.mjs";

try {
  const catalog = await checkCatalog();
  console.log(
    `Committed catalog matches public pricing, exchange rate, and capabilities for ${catalog.models.length} curated models.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "PackyAPI catalog check failed.");
  process.exitCode = 1;
}
