import { createHash } from "node:crypto";
import type { VerificationPlan } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;

export function normalizePlan(value: unknown): VerificationPlan {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("plan must be an object");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.checks) || raw.checks.length === 0)
    throw new Error("plan.checks must be a non-empty array");
  const ids = new Set<string>();
  const checks = raw.checks.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`checks[${index}] must be an object`);
    const check = entry as Record<string, unknown>;
    if (typeof check.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(check.id))
      throw new Error(`checks[${index}].id is invalid`);
    if (ids.has(check.id)) throw new Error(`duplicate check id: ${check.id}`);
    ids.add(check.id);
    if (typeof check.command !== "string" || check.command.length === 0)
      throw new Error(`checks[${index}].command is required`);
    if (check.command.includes("\0")) throw new Error(`checks[${index}].command contains NUL`);
    if (
      !Array.isArray(check.args) ||
      !check.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))
    ) {
      throw new Error(`checks[${index}].args must be a string array`);
    }
    const args = check.args as string[];
    const requirement: "required" | "optional" =
      check.requirement === "optional" ? "optional" : "required";
    const timeoutMs = typeof check.timeoutMs === "number" ? check.timeoutMs : DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000)
      throw new Error(`checks[${index}].timeoutMs is invalid`);
    if (check.cwd !== undefined && (typeof check.cwd !== "string" || check.cwd.length === 0))
      throw new Error(`checks[${index}].cwd is invalid`);
    return {
      id: check.id,
      command: check.command,
      args,
      ...(check.cwd === undefined ? {} : { cwd: check.cwd }),
      requirement,
      timeoutMs,
    };
  });
  const concurrency = raw.concurrency ?? 2;
  const repairBudget = raw.repairBudget ?? 1;
  if (!Number.isInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > 16)
    throw new Error("concurrency must be an integer from 1 to 16");
  if (
    !Number.isInteger(repairBudget) ||
    (repairBudget as number) < 0 ||
    (repairBudget as number) > 10
  )
    throw new Error("repairBudget must be an integer from 0 to 10");
  if (raw.version !== undefined && raw.version !== 1) throw new Error("unsupported plan version");
  if (raw.freshness !== undefined && raw.freshness !== "git")
    throw new Error("freshness must be git");
  return {
    version: 1,
    checks,
    concurrency: concurrency as number,
    freshness: "git",
    repairBudget: repairBudget as number,
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
