import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  buildDescriptors,
  canActivateAutomatically,
  loadCatalog,
  scoreDescriptor,
  searchDescriptors,
  type ToolDescriptor,
} from "../src/catalog.ts";
import { CatalogController, type ToolRuntime } from "../src/controller.ts";

function tool(name: string, description: string): ToolInfo {
  return {
    name,
    description,
    parameters: { type: "object" },
    sourceInfo: { path: `<test:${name}>`, source: "test", scope: "temporary", origin: "top-level" },
  } as ToolInfo;
}

async function fixture(): Promise<{ global: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-tool-catalog-"));
  const global = join(root, "home", "tool-catalog.json");
  const project = join(root, "project", "tool-catalog.json");
  await mkdir(join(root, "home"), { recursive: true });
  await mkdir(join(root, "project"), { recursive: true });
  return { global, project };
}

class FakeRuntime implements ToolRuntime {
  tools: ToolInfo[];
  active: string[];

  constructor(tools: ToolInfo[], active: string[]) {
    this.tools = tools;
    this.active = active;
  }

  getAllTools(): ToolInfo[] {
    return this.tools;
  }

  getActiveTools(): string[] {
    return [...this.active];
  }

  setActiveTools(names: string[]): void {
    const available = new Set(this.tools.map((entry) => entry.name));
    this.active = [...new Set(names.filter((name) => available.has(name)))];
  }
}

test("global and project catalogs merge by field with project precedence", async () => {
  const paths = await fixture();
  await writeFile(
    paths.global,
    JSON.stringify({
      tools: {
        browser: { deferred: true, keywords: ["web"], trust: "trusted", health: "healthy" },
      },
    }),
  );
  await writeFile(
    paths.project,
    JSON.stringify({
      tools: { browser: { keywords: ["page"], sideEffects: "network" }, local: { deferred: true } },
    }),
  );

  const loaded = await loadCatalog(paths);
  assert.deepEqual(loaded.config.browser, {
    deferred: true,
    keywords: ["page"],
    trust: "trusted",
    health: "healthy",
    sideEffects: "network",
  });
  assert.equal(loaded.sources.get("browser"), "project");
  assert.deepEqual([...loaded.projectConfigured].sort(), ["browser", "local"]);
});

test("invalid catalog is ignored with a warning", async () => {
  const paths = await fixture();
  await writeFile(paths.global, "{not-json");
  const loaded = await loadCatalog(paths);
  assert.deepEqual(loaded.config, {});
  assert.equal(loaded.warnings.length, 1);
});

test("search scoring prioritizes exact name, then name, keywords, and description", () => {
  const descriptors: ToolDescriptor[] = [
    {
      name: "browser",
      description: "Open pages",
      keywords: [],
      deferred: true,
      activationPolicy: "automatic",
      trust: "trusted",
      sideEffects: "network",
      health: "healthy",
      source: "global",
      projectConfigured: false,
      active: false,
    },
    {
      name: "browser_logs",
      description: "Read logs",
      keywords: [],
      deferred: true,
      activationPolicy: "automatic",
      trust: "trusted",
      sideEffects: "read",
      health: "healthy",
      source: "global",
      projectConfigured: false,
      active: false,
    },
    {
      name: "inspect",
      description: "Inspect an application",
      keywords: ["browser"],
      deferred: true,
      activationPolicy: "automatic",
      trust: "trusted",
      sideEffects: "read",
      health: "healthy",
      source: "global",
      projectConfigured: false,
      active: false,
    },
    {
      name: "open",
      description: "Use a browser",
      keywords: [],
      deferred: true,
      activationPolicy: "automatic",
      trust: "trusted",
      sideEffects: "read",
      health: "healthy",
      source: "global",
      projectConfigured: false,
      active: false,
    },
  ];
  assert.ok(
    scoreDescriptor(descriptors[0]!, "browser") > scoreDescriptor(descriptors[1]!, "browser"),
  );
  assert.deepEqual(
    searchDescriptors(descriptors, "browser", 10).map((entry) => entry.name),
    ["browser", "browser_logs", "inspect", "open"],
  );
});

test("only explicitly deferred tools are disabled and catalog tools stay active", async () => {
  const paths = await fixture();
  await writeFile(
    paths.global,
    JSON.stringify({
      tools: {
        deferred_tool: { deferred: true },
        normal_tool: { deferred: false },
        search_tools: { deferred: true },
      },
    }),
  );
  const runtime = new FakeRuntime(
    [
      tool("read", "Read"),
      tool("deferred_tool", "Deferred"),
      tool("normal_tool", "Normal"),
      tool("search_tools", "Search"),
      tool("tool_catalog", "Catalog"),
    ],
    ["read", "deferred_tool", "normal_tool"],
  );
  const controller = new CatalogController(runtime, paths);
  await controller.reload();
  assert.deepEqual(runtime.active.sort(), ["normal_tool", "read", "search_tools", "tool_catalog"]);
});

test("activation is additive and deactivation only removes catalog-owned tools", async () => {
  const paths = await fixture();
  await writeFile(paths.global, JSON.stringify({ tools: { extra: { deferred: true } } }));
  const runtime = new FakeRuntime(
    [
      tool("read", "Read"),
      tool("extra", "Extra"),
      tool("search_tools", "Search"),
      tool("tool_catalog", "Catalog"),
    ],
    ["read", "search_tools", "tool_catalog"],
  );
  const controller = new CatalogController(runtime, paths);
  await controller.reload();
  assert.deepEqual(controller.activate(["extra"], false), {
    activated: ["extra"],
    blocked: [],
    missing: [],
  });
  assert.ok(runtime.active.includes("read"));
  assert.ok(runtime.active.includes("extra"));
  const result = controller.deactivate(["read", "search_tools", "missing"]);
  assert.deepEqual(result, {
    activated: [],
    blocked: ["read", "search_tools"],
    missing: ["missing"],
  });
  assert.deepEqual(runtime.active.sort(), ["extra", "read", "search_tools", "tool_catalog"]);
});

test("untrusted project side-effecting tools do not auto-activate but explicit activation works", async () => {
  const paths = await fixture();
  await writeFile(
    paths.project,
    JSON.stringify({
      tools: {
        writer: { deferred: true, trust: "untrusted", sideEffects: "write" },
        reader: { deferred: true, trust: "untrusted", sideEffects: "read" },
      },
    }),
  );
  const runtime = new FakeRuntime(
    [
      tool("writer", "Write"),
      tool("reader", "Read"),
      tool("search_tools", "Search"),
      tool("tool_catalog", "Catalog"),
    ],
    ["search_tools", "tool_catalog"],
  );
  const controller = new CatalogController(runtime, paths);
  await controller.reload();
  const automatic = controller.activate(["writer", "reader"], true);
  assert.deepEqual(automatic, { activated: [], blocked: ["writer", "reader"], missing: [] });
  assert.deepEqual(controller.activate(["writer"], false).activated, ["writer"]);
  assert.equal(
    canActivateAutomatically(controller.descriptors().find((entry) => entry.name === "writer")!),
    false,
  );
});

test("reload applies changed metadata while preserving unrelated active state", async () => {
  const paths = await fixture();
  await writeFile(paths.global, JSON.stringify({ tools: { extra: { deferred: true } } }));
  const runtime = new FakeRuntime(
    [
      tool("read", "Read"),
      tool("extra", "Extra"),
      tool("search_tools", "Search"),
      tool("tool_catalog", "Catalog"),
    ],
    ["read", "extra"],
  );
  const controller = new CatalogController(runtime, paths);
  await controller.reload();
  assert.ok(!runtime.active.includes("extra"));
  controller.activate(["extra"], false);
  await writeFile(
    paths.global,
    JSON.stringify({ tools: { extra: { deferred: false, health: "healthy" } } }),
  );
  await controller.reload();
  assert.ok(runtime.active.includes("extra"));
  assert.equal(controller.descriptors().find((entry) => entry.name === "extra")?.health, "healthy");
});

test("descriptors are derived for every configured Pi tool", () => {
  const descriptors = buildDescriptors(
    [tool("read", "Read files")],
    { config: {}, sources: new Map(), projectConfigured: new Set(), warnings: [] },
    new Set(["read"]),
  );
  assert.deepEqual(descriptors[0], {
    name: "read",
    description: "Read files",
    keywords: [],
    deferred: false,
    activationPolicy: "manual",
    trust: "untrusted",
    sideEffects: "unknown",
    health: "unknown",
    source: "derived",
    projectConfigured: false,
    active: true,
  });
});
