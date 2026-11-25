import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogWriter, SEGMENT_BYTES, readWindow, segments } from "../src/logfile.ts";

async function withDir(run: (base: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "logfile-"));
  try {
    await run(join(dir, "task.stdout"), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Fills exactly one segment so the next write must rotate. */
const segment = (fill: string) => Buffer.alloc(SEGMENT_BYTES, fill);

test("reads a window from a log that never rotated", async () => {
  await withDir(async (base) => {
    const writer = new LogWriter(base);
    await writer.open();
    writer.write(Buffer.from("abcdef"));
    await writer.close();

    assert.deepEqual(await readWindow(base, { offset: 2, limit: 3 }), {
      offset: 2,
      nextOffset: 5,
      size: 6,
      retainedFrom: 0,
      eof: false,
      text: "cde",
    });
    assert.deepEqual(await readWindow(base, { limit: 2, tail: true }), {
      offset: 4,
      nextOffset: 6,
      size: 6,
      retainedFrom: 0,
      eof: true,
      text: "ef",
    });
  });
});

test("reports an absent log as empty rather than failing", async () => {
  await withDir(async (base) => {
    assert.deepEqual(await readWindow(base), {
      offset: 0,
      nextOffset: 0,
      size: 0,
      retainedFrom: 0,
      eof: true,
      text: "",
    });
  });
});

test("keeps logical offsets continuous across a rotation", async () => {
  await withDir(async (base) => {
    const writer = new LogWriter(base);
    await writer.open();
    writer.write(segment("a"));
    writer.write(Buffer.from("BOUNDARY"));
    await writer.close();

    const chain = await segments(base);
    assert.equal(chain.length, 2, "expected one archive plus the active segment");
    assert.deepEqual(
      chain.map((s) => s.start),
      [0, SEGMENT_BYTES],
    );

    // A read spanning the boundary stitches both segments back together.
    const across = await readWindow(base, { offset: SEGMENT_BYTES - 4, limit: 12 });
    assert.equal(across.text, "aaaaBOUNDARY");
    assert.equal(across.size, SEGMENT_BYTES + 8);
    assert.equal(across.eof, true);
    // Nothing has been evicted yet, so offset 0 is still addressable.
    assert.equal(across.retainedFrom, 0);
    assert.equal((await readWindow(base, { limit: 4 })).text, "aaaa");
  });
});

test("evicts the oldest segment and reports where retention now starts", async () => {
  await withDir(async (base, dir) => {
    const writer = new LogWriter(base);
    await writer.open();
    writer.write(segment("a"));
    writer.write(segment("b"));
    writer.write(Buffer.from("TAIL"));
    await writer.close();

    // Only the retained archive and the active segment survive on disk.
    const files = (await readdir(dir)).filter((n) => n.startsWith("task.stdout")).sort();
    assert.deepEqual(files, ["task.stdout", `task.stdout.${SEGMENT_BYTES}`]);

    const window = await readWindow(base, { offset: 0, limit: 4 });
    assert.equal(window.size, 2 * SEGMENT_BYTES + 4);
    assert.equal(window.retainedFrom, SEGMENT_BYTES);
    // Offset 0 was evicted, so the read starts at retention instead of returning "a" bytes.
    assert.equal(window.offset, SEGMENT_BYTES);
    assert.equal(window.text, "bbbb");

    const tail = await readWindow(base, { limit: 4, tail: true });
    assert.equal(tail.text, "TAIL");
    assert.equal(tail.eof, true);
  });
});

test("resumes from a cursor that rotation has since evicted", async () => {
  await withDir(async (base) => {
    const writer = new LogWriter(base);
    await writer.open();
    writer.write(Buffer.from("early"));
    const consumed = 5; // a reader that stopped here
    writer.write(segment("a"));
    writer.write(segment("b"));
    await writer.close();

    const resumed = await readWindow(base, { offset: consumed, limit: 16, tail: true });
    // The cursor is below retention, so the read advances instead of returning stale bytes.
    assert.equal(resumed.offset >= resumed.retainedFrom, true);
    assert.equal(resumed.offset > consumed, true);
    assert.equal(resumed.eof, true);
  });
});

test("never splits a single write across a rotation", async () => {
  await withDir(async (base) => {
    const writer = new LogWriter(base);
    await writer.open();
    writer.write(Buffer.alloc(SEGMENT_BYTES - 2, "a"));
    writer.write(Buffer.from("XYZ")); // would straddle the boundary if split
    await writer.close();

    const chain = await segments(base);
    assert.equal(chain[0]!.size, SEGMENT_BYTES - 2);
    const window = await readWindow(base, { limit: 3, tail: true });
    assert.equal(window.text, "XYZ");
  });
});

test("close resolves only once every queued write has reached disk", async () => {
  // The guarantee the runner depends on to make a terminal task's log complete. Unlike the
  // end-to-end test this is not timing-dependent: the writes are queued before close() is
  // even called, so an early return is always observable.
  await withDir(async (base) => {
    const writer = new LogWriter(base);
    await writer.open();
    let expected = 0;
    for (let i = 0; i < 20_000; i++) {
      const line = `line ${i}\n`;
      expected += line.length;
      writer.write(Buffer.from(line));
    }
    await writer.close();
    const window = await readWindow(base, { limit: 1024 * 1024, tail: true });
    assert.equal(window.size, expected);
    assert.match(window.text, /line 19999\n$/);
  });
});

test("surfaces a write failure when the writer is closed", async () => {
  await withDir(async (base) => {
    const writer = new LogWriter(base);
    await writer.open();
    writer.write(Buffer.from("ok"));
    await writer.close();
    // Writing after close must not resolve as if it succeeded.
    writer.write(Buffer.from("dropped"));
    await writer.drain();
    assert.equal((await readWindow(base)).text, "ok");
  });
});
