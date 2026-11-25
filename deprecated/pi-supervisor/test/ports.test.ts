import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStore } from "../src/store.ts";
import { TaskRunner } from "../src/runner.ts";
import { listeningPorts, parseListeningPorts } from "../src/ports.ts";

test("parses listening ports from lsof field output", () => {
  // `lsof -F n` emits one field per line: p<pid>, f<fd>, then n<address>.
  const stdout = ["p47777", "f12", "n*:41731", "p47778", "f12", "n127.0.0.1:8080", ""].join("\n");
  assert.deepEqual(parseListeningPorts(stdout), [8080, 41731]);
});

test("handles IPv6, duplicates, and unusable addresses", () => {
  assert.deepEqual(parseListeningPorts("n[::1]:3000\nn*:3000\nn*:notaport\nnbroken\n"), [3000]);
  assert.deepEqual(parseListeningPorts(""), []);
  // Ports outside the valid range are not reported.
  assert.deepEqual(parseListeningPorts("n*:0\nn*:70000\n"), []);
});

test("reports no ports for a pid that cannot be inspected", async () => {
  assert.deepEqual(await listeningPorts(0), []);
  assert.deepEqual(await listeningPorts(-1), []);
});

test("observes a port opened by a descendant of the supervised process", async (t) => {
  if (process.platform === "win32") return t.skip("process groups are POSIX-only");
  const dir = await mkdtemp(join(tmpdir(), "ports-"));
  const port = 45871;
  try {
    const store = new DurableStore(dir);
    await store.open();
    const runner = new TaskRunner(store);
    // The supervised process is a shell whose CHILD binds the port — the shape of a wrapper
    // script that sources an env file and then starts a server. The shell itself listens on
    // nothing, so inspecting only the recorded pid would find no ports at all.
    const task = await runner.start({
      command: "/bin/sh",
      args: ["-c", `${process.execPath} -e "require('net').createServer().listen(${port})" & wait`],
      cwd: dir,
      name: "wrapped",
      service: true,
    });
    assert.equal(task.state, "running");

    let ports: number[] = [];
    for (let attempt = 0; attempt < 60 && !ports.includes(port); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      // A fresh record each time, since view() caches by task id.
      ports =
        (await runner.view({ ...store.get(task.id)!, id: `${task.id}-${attempt}` })).ports ?? [];
    }
    assert.deepEqual(ports, [port], "expected the child's port via the process group");

    await runner.stop(task.id);
    // A terminal task never reports ports, even though one was cached while it ran.
    assert.equal((await runner.view(store.get(task.id)!)).ports, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
