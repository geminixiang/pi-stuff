import { readFile } from "node:fs/promises";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export const CATALOG_TOOL_NAMES = new Set(["search_tools", "tool_catalog"]);

export type ToolTrust = "trusted" | "untrusted";
export type SideEffects = "none" | "read" | "write" | "network" | "unknown";
export type ToolHealth = "healthy" | "degraded" | "unavailable" | "unknown";
export type ActivationPolicy = "automatic" | "manual";
export type CatalogSource = "derived" | "global" | "project";

export interface ToolConfig {
  deferred?: boolean;
  activationPolicy?: ActivationPolicy;
  keywords?: string[];
  trust?: ToolTrust;
  sideEffects?: SideEffects;
  health?: ToolHealth;
}

export interface ToolCatalogConfig {
  tools?: Record<string, ToolConfig>;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  keywords: string[];
  deferred: boolean;
  activationPolicy: ActivationPolicy;
  trust: ToolTrust;
  sideEffects: SideEffects;
  health: ToolHealth;
  source: CatalogSource;
  projectConfigured: boolean;
  active: boolean;
}

export interface CatalogPaths {
  global: string;
  project: string;
}

export interface LoadedCatalog {
  config: Record<string, ToolConfig>;
  sources: Map<string, CatalogSource>;
  projectConfigured: Set<string>;
  warnings: string[];
}

const TRUST_VALUES = new Set<ToolTrust>(["trusted", "untrusted"]);
const SIDE_EFFECT_VALUES = new Set<SideEffects>(["none", "read", "write", "network", "unknown"]);
const HEALTH_VALUES = new Set<ToolHealth>(["healthy", "degraded", "unavailable", "unknown"]);
const ACTIVATION_POLICY_VALUES = new Set<ActivationPolicy>(["automatic", "manual"]);

/**
 * The global catalog lives in the host's agent directory and the project catalog under its
 * configured directory name, both taken from the host rather than assumed, so a relocated
 * agent directory or a renamed config directory keeps the catalog with it.
 */
export function catalogPaths(cwd: string, agentDir = getAgentDir()): CatalogPaths {
  return {
    global: join(agentDir, "tool-catalog.json"),
    project: join(cwd, CONFIG_DIR_NAME, "tool-catalog.json"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolConfig(value: unknown, location: string): ToolConfig {
  if (!isRecord(value)) throw new Error(`${location} must be an object`);
  const config: ToolConfig = {};
  if (value.deferred !== undefined) {
    if (typeof value.deferred !== "boolean")
      throw new Error(`${location}.deferred must be boolean`);
    config.deferred = value.deferred;
  }
  if (value.activationPolicy !== undefined) {
    if (
      typeof value.activationPolicy !== "string" ||
      !ACTIVATION_POLICY_VALUES.has(value.activationPolicy as ActivationPolicy)
    ) {
      throw new Error(`${location}.activationPolicy is invalid`);
    }
    config.activationPolicy = value.activationPolicy as ActivationPolicy;
  }
  if (value.keywords !== undefined) {
    if (
      !Array.isArray(value.keywords) ||
      value.keywords.some((entry) => typeof entry !== "string")
    ) {
      throw new Error(`${location}.keywords must be an array of strings`);
    }
    config.keywords = [...new Set(value.keywords.map((entry) => entry.trim()).filter(Boolean))];
  }
  if (value.trust !== undefined) {
    if (typeof value.trust !== "string" || !TRUST_VALUES.has(value.trust as ToolTrust)) {
      throw new Error(`${location}.trust is invalid`);
    }
    config.trust = value.trust as ToolTrust;
  }
  if (value.sideEffects !== undefined) {
    if (
      typeof value.sideEffects !== "string" ||
      !SIDE_EFFECT_VALUES.has(value.sideEffects as SideEffects)
    ) {
      throw new Error(`${location}.sideEffects is invalid`);
    }
    config.sideEffects = value.sideEffects as SideEffects;
  }
  if (value.health !== undefined) {
    if (typeof value.health !== "string" || !HEALTH_VALUES.has(value.health as ToolHealth)) {
      throw new Error(`${location}.health is invalid`);
    }
    config.health = value.health as ToolHealth;
  }
  return config;
}

export function parseCatalog(value: unknown, location: string): Record<string, ToolConfig> {
  if (!isRecord(value)) throw new Error(`${location} must contain an object`);
  const toolsValue = value.tools ?? value;
  if (!isRecord(toolsValue)) throw new Error(`${location}.tools must be an object`);
  return Object.fromEntries(
    Object.entries(toolsValue).map(([name, config]) => [
      name,
      parseToolConfig(config, `${location}.tools.${name}`),
    ]),
  );
}

async function readCatalog(
  path: string,
): Promise<{ tools: Record<string, ToolConfig>; warning?: string }> {
  try {
    const text = await readFile(path, "utf8");
    return { tools: parseCatalog(JSON.parse(text) as unknown, path) };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { tools: {} };
    const message = error instanceof Error ? error.message : String(error);
    return { tools: {}, warning: `${path}: ${message}` };
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function loadCatalog(
  paths: CatalogPaths,
  projectTrusted = false,
): Promise<LoadedCatalog> {
  const [globalCatalog, projectCatalog] = await Promise.all([
    readCatalog(paths.global),
    readCatalog(paths.project),
  ]);
  const config: Record<string, ToolConfig> = {};
  const sources = new Map<string, CatalogSource>();
  for (const [name, value] of Object.entries(globalCatalog.tools)) {
    config[name] = { ...value };
    sources.set(name, "global");
  }
  for (const [name, value] of Object.entries(projectCatalog.tools)) {
    const projectValue = { ...value };
    if (!projectTrusted) {
      // Project metadata may narrow privileges, but an untrusted project may not grant them.
      if (projectValue.trust === "trusted") delete projectValue.trust;
      if (projectValue.activationPolicy === "automatic") delete projectValue.activationPolicy;
    }
    config[name] = { ...config[name], ...projectValue };
    sources.set(name, "project");
  }
  return {
    config,
    sources,
    projectConfigured: new Set(Object.keys(projectCatalog.tools)),
    warnings: [globalCatalog.warning, projectCatalog.warning].filter(
      (entry): entry is string => entry !== undefined,
    ),
  };
}

export function buildDescriptors(
  tools: ToolInfo[],
  loaded: LoadedCatalog,
  activeTools: ReadonlySet<string>,
): ToolDescriptor[] {
  return tools.map((tool) => {
    const config = loaded.config[tool.name] ?? {};
    return {
      name: tool.name,
      description: tool.description,
      keywords: config.keywords ?? [],
      deferred: config.deferred === true && !CATALOG_TOOL_NAMES.has(tool.name),
      activationPolicy: config.activationPolicy ?? "manual",
      trust: config.trust ?? "untrusted",
      sideEffects: config.sideEffects ?? "unknown",
      health: config.health ?? "unknown",
      source: loaded.sources.get(tool.name) ?? "derived",
      projectConfigured: loaded.projectConfigured.has(tool.name),
      active: activeTools.has(tool.name),
    };
  });
}

function terms(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(Boolean);
}

export function scoreDescriptor(descriptor: ToolDescriptor, query: string): number {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  if (descriptor.name.toLowerCase() === normalized) return 10_000;
  const queryTerms = terms(normalized);
  const name = descriptor.name.toLowerCase();
  const keywordSet = new Set(descriptor.keywords.map((keyword) => keyword.toLowerCase()));
  const description = descriptor.description.toLowerCase();
  return queryTerms.reduce((score, term) => {
    if (name === term) return score + 100;
    if (name.includes(term)) return score + 40;
    if (keywordSet.has(term)) return score + 20;
    if (descriptor.keywords.some((keyword) => keyword.toLowerCase().includes(term)))
      return score + 10;
    if (description.includes(term)) return score + 2;
    return score;
  }, 0);
}

export function searchDescriptors(
  descriptors: ToolDescriptor[],
  query: string,
  limit: number,
): ToolDescriptor[] {
  return descriptors
    .map((descriptor) => ({ descriptor, score: scoreDescriptor(descriptor, query) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.descriptor.name.localeCompare(right.descriptor.name),
    )
    .slice(0, limit)
    .map((entry) => entry.descriptor);
}

export function canActivateAutomatically(descriptor: ToolDescriptor): boolean {
  return (
    descriptor.source !== "derived" &&
    descriptor.deferred &&
    descriptor.activationPolicy === "automatic" &&
    descriptor.trust === "trusted" &&
    (descriptor.sideEffects === "none" || descriptor.sideEffects === "read") &&
    (descriptor.health === "healthy" || descriptor.health === "degraded")
  );
}

export function activationRequiresConfirmation(descriptor: ToolDescriptor): boolean {
  return (
    descriptor.activationPolicy === "manual" ||
    descriptor.trust !== "trusted" ||
    descriptor.sideEffects === "write" ||
    descriptor.sideEffects === "network" ||
    descriptor.sideEffects === "unknown"
  );
}
