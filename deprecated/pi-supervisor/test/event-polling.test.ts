import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROTOCOL_VERSION, type Request, type TaskEvent } from "@geminixiang/pi-task-protocol";
import supervisor from "../extensions/pi-supervisor.ts";
import { TaskClient } from "../src/daemon.ts";

// Exercise the registered lifecycle without opening a socket or starting taskd.
test("event polling acknowledges progress once and retries a failed ack on an empty poll", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(TaskClient.prototype, "ping", async () => ({
    pid: 1,
    protocolVersion: PROTOCOL_VERSION,
  }));
  const acknowledgements: number[] = [];
  const polls: number[] = [];
  let pendingEvents: TaskEvent[] = [];
  let failAck = false;
  t.mock.method(TaskClient.prototype, "request", async (request: Request) => {
    if (request.method === "list") return [];
    if (request.method === "events") {
      polls.push(request.params.after ?? 0);
      const events = pendingEvents;
      pendingEvents = [];
      return { events, nextAfter: events.at(-1)?.sequence ?? request.params.after ?? 0 };
    }
    if (request.method === "ack") {
      acknowledgements.push(request.params.sequence);
      if (failAck) {
        failAck = false;
        throw new Error("Temporary acknowledgement failure");
      }
      return { cursor: request.params.sequence };
    }
    throw new Error(`Unexpected request: ${request.method}`);
  });
  const handlers = new Map<string, (...args: any[]) => unknown>();
  supervisor({
    on(event: string, handler: (...args: any[]) => unknown) {
      handlers.set(event, handler);
    },
    registerTool() {},
  } as unknown as ExtensionAPI);
  const tick = async () => {
    t.mock.timers.tick(500);
    await setImmediate();
  };
  const event = (sequence: number): TaskEvent => ({
    version: PROTOCOL_VERSION,
    sequence,
    timestamp: new Date().toISOString(),
    taskId: "another-session-task",
    type: "created",
    data: {},
  });
  try {
    await handlers.get("session_start")!(
      {},
      {
        ui: {
          setStatus() {},
          notify(message: string) {
            assert.fail(message);
          },
        },
        sessionManager: { getSessionId: () => "polling-test" },
      },
    );
    await setImmediate();
    assert.equal(polls.length, 1);
    assert.deepEqual(acknowledgements, []);
    pendingEvents = [event(1)];
    await tick();
    assert.deepEqual(acknowledgements, [1]);
    for (let index = 0; index < 10; index++) await tick();
    assert.equal(polls.length, 12);
    assert.deepEqual(acknowledgements, [1]);
    pendingEvents = [event(2), event(3)];
    failAck = true;
    await tick();
    assert.deepEqual(acknowledgements, [1, 3]);
    await tick();
    assert.deepEqual(acknowledgements, [1, 3, 3]);
    assert.equal(polls.at(-1), 3);
    await tick();
    assert.deepEqual(acknowledgements, [1, 3, 3]);
    pendingEvents = [event(4)];
    await tick();
    assert.deepEqual(acknowledgements, [1, 3, 3, 4]);
  } finally {
    await handlers.get("session_shutdown")!({ reason: "reload" });
    await tick();
  }
});
