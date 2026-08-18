#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(resolve(tmpdir(), "pi-packyapi-smoke-"));
try {
  writeFileSync(resolve(agentDir, "models.json"), '{"providers":{}}\n');
  const output = execFileSync(
    "pi",
    [
      "--approve",
      "--offline",
      "--no-session",
      "--no-extensions",
      "--extension",
      resolve(packageRoot, "extensions/index.ts"),
      "--list-models",
      "packyapi",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PACKYAPI_API_KEY: "smoke-test" },
    },
  );
  for (const id of ["deepseek-v4-flash", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
    if (!output.includes(id)) throw new Error(`Pi did not list PackyAPI model: ${id}`);
  }
  console.log("Pi loaded the PackyAPI extension and listed all 4 curated models.");
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}
