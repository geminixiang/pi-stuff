import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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

test("duplicate acknowledgements neither rewrite nor clone the snapshot", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "task-store-"));
  try {
    const store = new DurableStore(dir);
    await store.open();
    await store.create(record("historical-task"));
    await store.ack("consumer", 1);
    const before = await lstat(store.snapshotPath, { bigint: true });
    const snapshot = await readFile(store.snapshotPath, "utf8");
    const clone = t.mock.method(globalThis, "structuredClone");
    await Promise.all(Array.from({ length: 30 }, () => store.ack("consumer", 1)));
    await store.ack("new-consumer", 0);
    assert.equal(clone.mock.callCount(), 0);
    const after = await lstat(store.snapshotPath, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.ctimeNs, before.ctimeNs);
    assert.equal(await readFile(store.snapshotPath, "utf8"), snapshot);
    assert.equal(store.cursor("consumer"), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("acknowledgement validation stays serialized, rejects invalid cursors, and recovers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-store-"));
  try {
    const store = new DurableStore(dir);
    await store.open();
    await store.emit("x", "created", {});
    await store.ack("consumer", 1);
    // The emit must finish before ack(2) validates, and the formerly duplicate ack(1)
    // must validate after ack(2) rather than bypassing the queue.
    const results = await Promise.allSettled([
      store.emit("x", "state", {}),
      store.ack("consumer", 2),
      store.ack("consumer", 1),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "fulfilled", "rejected"],
    );
    assert.equal(store.cursor("consumer"), 2);
    for (const sequence of [-1, 1, 3, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      await assert.rejects(store.ack("consumer", sequence), /Invalid event acknowledgement/);
    await store.ack("consumer", 2);
    await store.emit("x", "state", {});
    await store.ack("consumer", 3);
    const reopened = new DurableStore(dir);
    await reopened.open();
    assert.equal(reopened.cursor("consumer"), 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed acknowledgements remain retryable and no-ops do not publish uncommitted state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-store-"));
  try {
    const store = new DurableStore(dir);
    await store.open();
    await store.emit("x", "created", {});
    const backup = join(dir, "snapshot.backup");
    await rename(store.snapshotPath, backup);
    await mkdir(store.snapshotPath);
    await assert.rejects(store.ack("consumer", 1));
    assert.equal(store.cursor("consumer"), 0);
    // This must not publish the cursor left in working state by the failed write.
    await store.ack("other-consumer", 0);
    assert.equal(store.cursor("consumer"), 0);
    await rm(store.snapshotPath, { recursive: true });
    await rename(backup, store.snapshotPath);
    await store.ack("consumer", 1);
    assert.equal(store.cursor("consumer"), 1);
    const reopened = new DurableStore(dir);
    await reopened.open();
    assert.equal(reopened.cursor("consumer"), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("caught-up event polls skip spool reads and still observe later events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-store-"));
  try {
    const store = new DurableStore(dir);
    await store.open();
    await store.emit("x", "created", {});
    const backup = join(dir, "events.backup");
    await rename(store.eventsPath, backup);
    // A directory makes any attempted read fail rather than silently returning no events.
    await mkdir(store.eventsPath);
    assert.deepEqual(await store.events(1), []);
    assert.deepEqual(await store.events(2), []);
    await assert.rejects(store.events(0));
    await rm(store.eventsPath, { recursive: true });
    await rename(backup, store.eventsPath);
    await store.emit("x", "state", {});
    assert.deepEqual(
      (await store.events(1)).map((event) => event.sequence),
      [2],
    );
    const reopened = new DurableStore(dir);
    await reopened.open();
    assert.deepEqual(
      (await reopened.events(0, 1)).map((event) => event.sequence),
      [1],
    );
    assert.deepEqual(
      (await reopened.events(1)).map((event) => event.sequence),
      [2],
    );
    assert.deepEqual(await reopened.events(2), []);
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
