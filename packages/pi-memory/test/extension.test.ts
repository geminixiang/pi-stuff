import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import memoryExtension from "../index.js";
import { MemoryStore } from "../src/store.js";

test("extension registers memory tools, command, and retrieval hook", () => {
  const tools: Array<{ name: string; execute: Function }> = [];
  const commands: Array<{ name: string; options: unknown }> = [];
  const events: string[] = [];
  const pi = {
    registerTool(tool: { name: string; execute: Function }) {
      tools.push(tool);
    },
    registerCommand(name: string, options: unknown) {
      commands.push({ name, options });
    },
    on(event: string) {
      events.push(event);
    },
  };
  memoryExtension(pi as never);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["memory_propose", "memory_search", "memory_manage"],
  );
  assert.deepEqual(
    commands.map((command) => command.name),
    ["memory"],
  );
  assert.deepEqual(events, ["before_agent_start"]);
});

test("management tool shows informed confirmation payload", async () => {
  const tools: Array<{ name: string; execute: Function }> = [];
  const root = await mkdtemp(join(tmpdir(), "pi-memory-extension-"));
  const cwd = join(root, "project");
  await mkdir(cwd);
  let confirmation = "";
  const pi = {
    registerTool(tool: { name: string; execute: Function }) {
      tools.push(tool);
    },
    registerCommand() {},
    on() {},
  };
  memoryExtension(pi as never);
  const context = {
    cwd,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      confirm: async (_title: string, details: string) => {
        confirmation = details;
        return true;
      },
    },
  };
  const propose = tools.find((tool) => tool.name === "memory_propose");
  const search = tools.find((tool) => tool.name === "memory_search");
  const manage = tools.find((tool) => tool.name === "memory_manage");
  assert.ok(propose && search && manage);
  await propose.execute(
    "call",
    {
      scope: "project",
      text: "Use PostgreSQL for audits",
      source: "ADR-42",
      confidence: 0.9,
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
    undefined,
    undefined,
    context,
  );
  const found = await search.execute(
    "call",
    { query: "PostgreSQL", statuses: ["candidate"] },
    undefined,
    undefined,
    context,
  );
  const id = /\[([^\]]+)\]/.exec(found.content[0].text)?.[1];
  assert.ok(id);
  await manage.execute("call", { action: "approve", id }, undefined, undefined, context);
  assert.match(confirmation, /scope=project/);
  assert.match(confirmation, /text=Use PostgreSQL for audits/);
  assert.match(confirmation, /provenance=ADR-42/);
  assert.match(confirmation, /confidence=0\.9/);
  assert.match(confirmation, /expiry=2030-/);
  assert.match(confirmation, /version=1 status=candidate/);
});

test("management tool refuses non-interactive transitions", async () => {
  const tools: Array<{ name: string; execute: Function }> = [];
  const pi = {
    registerTool(tool: { name: string; execute: Function }) {
      tools.push(tool);
    },
    registerCommand() {},
    on() {},
  };
  memoryExtension(pi as never);
  const manage = tools.find((tool) => tool.name === "memory_manage");
  assert.ok(manage);
  // The runtime records anything a tool returns as a success and marks an error only when
  // execute throws, so a refusal has to reject rather than return an isError result.
  await assert.rejects(
    manage.execute("call", { action: "approve", id: "id" }, undefined, undefined, {
      cwd: "/tmp",
      hasUI: false,
      ui: { confirm: async () => true },
    }),
    /interactive confirmation/,
  );
});

test("a declined confirmation is reported as declined, not as a malfunction", async () => {
  const tools: Array<{ name: string; execute: Function }> = [];
  const pi = {
    registerTool(tool: { name: string; execute: Function }) {
      tools.push(tool);
    },
    registerCommand() {},
    on() {},
  };
  memoryExtension(pi as never);
  const manage = tools.find((tool) => tool.name === "memory_manage");
  assert.ok(manage);
  const root = await mkdtemp(join(tmpdir(), "pi-memory-decline-"));
  const store = new MemoryStore(root, join(root, "agent"));
  const candidate = await store.propose({
    scope: "project",
    text: "Pin the compiler version across packages",
    provenance: { source: "decision log", author: "user" },
    confidence: 0.9,
    tags: [],
  });
  await assert.rejects(
    manage.execute("call", { action: "approve", id: candidate.id }, undefined, undefined, {
      cwd: root,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { confirm: async () => false },
    }),
    /cancelled/i,
  );
  // A missing record is a different failure and must not be reported as a decline.
  await assert.rejects(
    manage.execute("call", { action: "approve", id: "nope" }, undefined, undefined, {
      cwd: root,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { confirm: async () => true },
    }),
    /Verify the identifier/,
  );
});
