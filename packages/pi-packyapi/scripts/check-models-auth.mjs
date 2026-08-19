#!/usr/bin/env node
import { checkAuthenticatedVisibility } from "./model-catalog.mjs";

try {
  const result = await checkAuthenticatedVisibility({ apiKey: process.env.PACKYAPI_API_KEY });
  console.log(`Authenticated token can see all ${result.supported.length} supported models.`);
  if (result.extraVisible.length > 0) {
    console.log(`Visible but unsupported models: ${result.extraVisible.join(", ")}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "PackyAPI model visibility check failed.");
  process.exitCode = 1;
}
