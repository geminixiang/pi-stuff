import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@geminixiang/pi-task-protocol";
import { IncompatibleProtocolError, TaskClient, TaskDaemon } from "../src/daemon.ts";

test("reports an incompatible daemon protocol with its pid", async () => {
  const root = await mkdtemp(join(tmpdir(), "daemon-version-"));
  const socketPath = join(root, "d.sock");
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      const request = JSON.parse(String(chunk).trim()) as { id: string };
      socket.end(
        `${JSON.stringify({ version: PROTOCOL_VERSION - 1, id: request.id, ok: true, result: { pid: 12345 } })}\n`,
      );
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await assert.rejects(
      new TaskClient(socketPath).ping(),
      (error: unknown) =>
        error instanceof IncompatibleProtocolError &&
        error.runningVersion === PROTOCOL_VERSION - 1 &&
        error.daemonPid === 12345,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("identifies an incompatible daemon that rejected the request before naming itself", async () => {
  const root = await mkdtemp(join(tmpdir(), "daemon-reject-"));
  const socketPath = join(root, "d.sock");
  // A daemon on an older protocol fails our request during schema validation, so it answers
  // `ok: false` and never reports its pid — the exact shape observed from a live v1 taskd.
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk) => {
      const request = JSON.parse(String(chunk).trim()) as { id: string };
      socket.end(
        `${JSON.stringify({
          version: PROTOCOL_VERSION - 1,
          id: request.id,
          ok: false,
          error: "Invalid request: must be equal to constant",
        })}\n`,
      );
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await writeFile(`${socketPath}.lock`, "36812\n");
    const client = new TaskClient(socketPath);
    await assert.rejects(
      client.ping(),
      (error: unknown) =>
        error instanceof IncompatibleProtocolError &&
        error.runningVersion === PROTOCOL_VERSION - 1 &&
        // The rejection carries no pid, which is why the lock file is the fallback.
        error.daemonPid === undefined,
    );
    assert.equal(await client.daemonPid(), 36812);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("reports no daemon pid when the lock is absent or unusable", async () => {
  const root = await mkdtemp(join(tmpdir(), "daemon-lock-"));
  try {
    const client = new TaskClient(join(root, "d.sock"));
    assert.equal(await client.daemonPid(), undefined);
    await writeFile(join(root, "d.sock.lock"), "not-a-pid\n");
    assert.equal(await client.daemonPid(), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stops every running process owned by a session", async () => {
  const root = await mkdtemp(join(tmpdir(), "daemon-owner-"));
  const socket = join(root, "d.sock");
  const data = join(root, "data");
  const daemon = new TaskDaemon(socket, data);
  try {
    await daemon.start();
    const client = new TaskClient(socket);
    const owned = await client.request<{ id: string }>({
      method: "start",
      params: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        cwd: root,
        ownerSessionId: "session-a",
      },
    });
    const other = await client.request<{ id: string }>({
      method: "start",
      params: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        cwd: root,
        ownerSessionId: "session-b",
      },
    });
    const stopped = await client.request<{ id: string; state: string }[]>({
      method: "stopOwner",
      params: { ownerSessionId: "session-a" },
    });
    assert.deepEqual(
      stopped.map((record) => record.id),
      [owned.id],
    );
    assert.equal(stopped[0]?.state, "stopped");
    assert.equal(
      (
        await client.request<{ state: string }>({
          method: "get",
          params: { taskId: other.id },
        })
      ).state,
      "running",
    );
    await client.request({ method: "stop", params: { taskId: other.id } });
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("aborts a waiting client request without stopping the task", async () => {
  const root = await mkdtemp(join(tmpdir(), "daemon-abort-"));
  const socket = join(root, "d.sock");
  const data = join(root, "data");
  const daemon = new TaskDaemon(socket, data);
  try {
    await daemon.start();
    const client = new TaskClient(socket);
    const task = await client.request<{ id: string }>({
      method: "start",
      params: {
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        cwd: root,
      },
    });
    const controller = new AbortController();
    const waiting = client.request(
      {
        method: "wait",
        params: { taskId: task.id, timeoutMs: 60_000 },
      },
      controller.signal,
    );
    controller.abort(new Error("user cancelled"));
    await assert.rejects(waiting, /user cancelled/);
    const running = await client.request<{ state: string }>({
      method: "get",
      params: { taskId: task.id },
    });
    assert.equal(running.state, "running");
    await client.request({ method: "stop", params: { taskId: task.id } });
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("reconciles unverifiable active records as orphaned", async () => {
  const root = await mkdtemp(join(tmpdir(), "daemon-"));
  const socket = join(root, "d.sock");
  const data = join(root, "data");
  try {
    let daemon = new TaskDaemon(socket, data);
    await daemon.start();
    const client = new TaskClient(socket);
    await client.ping();
    await daemon.close();
    const now = new Date().toISOString();
    await daemon.store.put({
      id: "offline-task",
      spec: { command: "node", cwd: root },
      state: "running",
      createdAt: now,
      updatedAt: now,
    });
    daemon = new TaskDaemon(socket, data);
    await daemon.start();
    assert.equal((await client.ping()).pid, process.pid);
    const result = await client.request<{
      events: { taskId: string; type: string; data: Record<string, unknown> }[];
    }>({ method: "events", params: { cursor: "test", after: 0 } });
    assert(
      result.events.some(
        (event) =>
          event.taskId === "offline-task" &&
          event.type === "terminal" &&
          event.data.reason === "unverified_process_identity",
      ),
    );
    await daemon.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
