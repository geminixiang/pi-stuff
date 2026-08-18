#!/usr/bin/env node
import { checkAuthenticatedVisibility } from "./model-catalog.mjs";

try {
  const ids = await checkAuthenticatedVisibility({ apiKey: process.env.PACKYAPI_API_KEY });
  console.log(`Authenticated token can see all ${ids.length} curated models.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "PackyAPI model visibility check failed.");
  process.exitCode = 1;
}
