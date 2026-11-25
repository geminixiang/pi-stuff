import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableStore } from "../src/store.ts";
import { TaskRunner } from "../src/runner.ts";

test("starts, reads offset output, and waits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-"));
  try {
    const store = new DurableStore(dir);
    await store.open();
    const runner = new TaskRunner(store);
    const task = await runner.start({
      command: process.execPath,
      args: ["-e", "process.stdout.write('abcdef')"],
      cwd: dir,
    });
    const done = await runner.wait(task.id);
    assert.equal(done.state, "succeeded");
    assert.deepEqual(await runner.output(task.id, "stdout", 2, 3), {
      stream: "stdout",
      offset: 2,
      nextOffset: 5,
      size: 6,
      retainedFrom: 0,
      eof: false,
      text: "cde",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a terminal state means the log on disk is already complete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-"));
  try {
    const store = new DurableStore(dir);
    await store.open();
    const runner = new TaskRunner(store);
    // Sets `exitCode` rather than calling `process.exit`, which on Linux discards the
    // child's own pending writes to a pipe. That would truncate the output before taskd
    // ever received it, testing the child's flushing instead of the daemon's.
    const task = await runner.start({
      command: process.execPath,
      args: [
        "-e",
        "for(let i=0;i<100000;i++)console.log(`line ${i}`);console.error('FATAL: last words');process.exitCode=3",
      ],
      cwd: dir,
    });
    const done = await runner.wait(task.id, 30_000);
    assert.equal(done.state, "failed");
    assert.equal(done.exitCode, 3);
    // Read immediately: nothing may still be in flight to disk once the task is terminal.
    const out = await runner.output(task.id, "stdout", 0, 1024 * 1024, true);
    let expected = 0;
    for (let i = 0; i < 100000; i++) expected += `line ${i}\n`.length;
    assert.equal(out.size, expected, "every byte the child wrote must be on disk");
    assert.match(out.text, /line 99999\n$/);
    const err = await runner.output(task.id, "stderr", 0, 1024 * 1024, true);
    assert.match(err.text, /FATAL: last words/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tails the end of a log without knowing its size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-"));
  try {
    const store = new DurableStore(dir);
    await store.open();
    const runner = new TaskRunner(store);
    const task = await runner.start({
      command: process.execPath,
      args: ["-e", "for (let i = 0; i < 500; i++) console.log(`line ${i}`)"],
      cwd: dir,
    });
    assert.equal((await runner.wait(task.id)).state, "succeeded");

    const tail = await runner.output(task.id, "stdout", 0, 32, true);
    assert.equal(tail.eof, true);
    assert.equal(tail.nextOffset, tail.size);
    assert.equal(tail.offset, tail.size - 32);
    assert.match(tail.text, /line 499\n$/);

    // A tail bounded by a resume offset never rewinds behind output already consumed.
    const resumed = await runner.output(task.id, "stdout", tail.size - 8, 4096, true);
    assert.equal(resumed.offset, tail.size - 8);

    // A whole-file tail degrades to reading from the start rather than a negative offset.
    const whole = await runner.output(task.id, "stdout", 0, 1024 * 1024, true);
    assert.equal(whole.offset, 0);
    assert.equal(whole.text.startsWith("line 0\n"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps logging past the segment size instead of going silent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-"));
  try {
    const store = new DurableStore(dir);
    await store.open();
    const runner = new TaskRunner(store);
    // Writes well past SEGMENT_BYTES, forcing rotation, then prints a final marker.
    const task = await runner.start({
      command: process.execPath,
      args: [
        "-e",
        "const c='x'.repeat(1024*1024);for(let i=0;i<20;i++)process.stdout.write(c);process.stdout.write('AFTER-ROTATION')",
      ],
      cwd: dir,
    });
    assert.equal((await runner.wait(task.id, 30_000)).state, "succeeded");

    // The last thing written is still readable — the old cap would have dropped it.
    const tail = await runner.output(task.id, "stdout", 0, 4096, true);
    assert.equal(tail.text.endsWith("AFTER-ROTATION"), true);
    assert.equal(tail.size, 20 * 1024 * 1024 + "AFTER-ROTATION".length);
    assert.equal(tail.eof, true);

    // Rotation evicted the oldest bytes, and the read reports where retention now starts
    // rather than silently returning the wrong bytes for offset 0.
    assert.equal(tail.retainedFrom > 0, true);
    const evicted = await runner.output(task.id, "stdout", 0, 4096, false);
    assert.equal(evicted.offset, tail.retainedFrom);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("uses literal output readiness and fails on readiness timeout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-"));
  try {
    const store = new DurableStore(dir);
    await store.open();
    const runner = new TaskRunner(store);
    const ready = await runner.start({
      command: process.execPath,
      args: ["-e", "console.log('ready [literal]');setInterval(()=>{},1000)"],
      cwd: dir,
      service: true,
      readiness: { type: "output", substring: "[literal]" },
    });
    assert.equal((await runner.wait(ready.id)).state, "ready");
    await runner.stop(ready.id);
    const timedOut = await runner.start({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: dir,
      service: true,
      readiness: { type: "output", substring: "never" },
      readinessTimeoutMs: 50,
    });
    const failed = await runner.wait(timedOut.id, 2_000);
    assert.equal(failed.state, "failed");
    assert.equal(failed.error, "Readiness timed out");
    assert.equal(
      (await store.events(0)).find(
        (event) => event.taskId === timedOut.id && event.type === "terminal",
      )?.data.reason,
      "readiness_timed_out",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stops the complete process group", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-"));
  try {
    const store = new DurableStore(dir);
    await store.open();
    const runner = new TaskRunner(store);
    const task = await runner.start({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: dir,
      service: true,
    });
    assert.equal((await runner.stop(task.id)).state, "stopped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
