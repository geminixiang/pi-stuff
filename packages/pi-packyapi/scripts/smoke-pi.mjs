#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(readFileSync(resolve(packageRoot, "catalog/models.json"), "utf8"));

function compatiblePi() {
  const executable = process.platform === "win32" ? "pi.cmd" : "pi";
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory, executable);
    if (!existsSync(candidate)) continue;
    try {
      const version = execFileSync(candidate, ["--version"], { encoding: "utf8" }).trim();
      const [major, minor] = version.split(".").map(Number);
      if (major > 0 || (major === 0 && Number.isFinite(minor) && minor >= 84)) return candidate;
    } catch {
      // Try the next Pi installation on PATH.
    }
  }
  throw new Error("pi-packyapi smoke test requires Pi 0.84 or newer on PATH.");
}

const pi = compatiblePi();
const agentDir = mkdtempSync(resolve(tmpdir(), "pi-packyapi-smoke-"));
try {
  writeFileSync(resolve(agentDir, "models.json"), '{"providers":{}}\n');
  const output = execFileSync(
    pi,
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
  for (const { id } of catalog.models) {
    if (!output.includes(id)) throw new Error(`Pi did not list PackyAPI model: ${id}`);
  }
  console.log(
    `Pi loaded the PackyAPI extension and listed all ${catalog.models.length} supported models.`,
  );
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}
