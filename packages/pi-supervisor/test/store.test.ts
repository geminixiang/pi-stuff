import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStore } from "../src/store.ts";

const record = (id: string) => {
  const now = new Date().toISOString();
  return {
    id,
    spec: { command: "node", cwd: "/tmp" },
    state: "starting" as const,
    createdAt: now,
    updatedAt: now,
  };
};

test("serializes mutations, spools unique sequences, and persists acknowledgements", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-store-"));
  try {
    const store = new DurableStore(dir);
    await store.open();
    const events = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.emit(String(index), "created", {})),
    );
    assert.deepEqual(
      events.map((event) => event.sequence),
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    await store.ack("consumer", events.at(-1)!.sequence);
    const reopened = new DurableStore(dir);
    await reopened.open();
    assert.equal(reopened.cursor("consumer"), 20);
    await assert.rejects(reopened.ack("consumer", 0), /Invalid event acknowledgement/);
    assert.equal((await lstat(dir)).mode & 0o777, 0o700);
    assert.equal((await lstat(reopened.snapshotPath)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reconciles sequence from valid JSONL tail and tolerates one truncated final line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-store-"));
  try {
    let store = new DurableStore(dir);
    await store.open();
    await store.emit("x", "created", {});
    const snapshot = JSON.parse(await readFile(store.snapshotPath, "utf8")) as { sequence: number };
    snapshot.sequence = 0;
    await writeFile(store.snapshotPath, JSON.stringify(snapshot));
    await appendFile(store.eventsPath, '{"version":1,"sequence":2');
    store = new DurableStore(dir);
    await store.open();
    assert.equal((await store.emit("y", "created", {})).sequence, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transition and event are one mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-store-"));
  try {
    const store = new DurableStore(dir);
    await store.open();
    const task = record("x");
    await store.create(task);
    await store.transition({ record: task, state: "running", type: "state", data: {} });
    assert.equal(store.get("x")?.state, "running");
    assert.equal((await store.events(0)).at(-1)?.data.state, "running");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
