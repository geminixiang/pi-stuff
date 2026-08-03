import test from "node:test";
import assert from "node:assert/strict";
import { SubagentRpcClient, type PiEventBus } from "../src/subagents.ts";

class FakeBus implements PiEventBus {
  handlers = new Map<string, Set<(data: unknown) => void>>();
  on(event: string, handler: (data: unknown) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }
  emit(event: string, data: unknown): void {
    for (const h of this.handlers.get(event) ?? []) h(data);
  }
}

test("uses process-local public pi-subagents v2 RPC without internal imports", async () => {
  const bus = new FakeBus();
  bus.on("subagents:rpc:ping", (raw) => {
    const { requestId } = raw as { requestId: string };
    bus.emit(`subagents:rpc:ping:reply:${requestId}`, { success: true, data: { version: 2 } });
  });
  bus.on("subagents:rpc:spawn", (raw) => {
    const { requestId } = raw as { requestId: string };
    bus.emit(`subagents:rpc:spawn:reply:${requestId}`, { success: true, data: { id: "agent-1" } });
  });
  const client = new SubagentRpcClient(bus);
  assert.equal((await client.ping()).version, 2);
  assert.equal((await client.spawn("Explore", "inspect")).id, "agent-1");
  assert.equal(client.capabilities.lifecycleEvents, false);
  assert.equal(client.capabilities.durableStatus, false);
});
