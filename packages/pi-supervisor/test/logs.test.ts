import test from "node:test";
import assert from "node:assert/strict";
import type { TaskRecord } from "@geminixiang/pi-task-protocol";
import { compileFilter, describeTask, renderStream, selectWindow } from "../src/logs.ts";
import type { OutputResult } from "../src/runner.ts";

const record = (spec: Partial<TaskRecord["spec"]>): TaskRecord =>
  ({
    id: "id",
    spec: { command: "node", cwd: "/tmp", ...spec },
    state: "running",
    createdAt: "",
    updatedAt: "",
  }) as TaskRecord;

const output = (over: Partial<OutputResult>): OutputResult => ({
  stream: "stdout",
  offset: 0,
  nextOffset: 0,
  size: 0,
  retainedFrom: 0,
  eof: true,
  text: "",
  ...over,
});

test("names a task by label, falling back to its command line", () => {
  assert.equal(describeTask(record({ name: "dev-server" })), "dev-server");
  assert.equal(describeTask(record({ command: "npm", args: ["run", "dev"] })), "npm run dev");
});

test("selects a window that reaches the end of a long-lived log", () => {
  // Nothing consumed yet: show the end of the log, not a startup banner.
  assert.deepEqual(selectWindow("new", 0), { tail: true });
  // Resuming stays anchored to what was already shown, but remains capped by tailing.
  assert.deepEqual(selectWindow("new", 4096), { offset: 4096, tail: true });
  // An explicit tail ignores the cursor entirely.
  assert.deepEqual(selectWindow("tail", 4096), { tail: true });
  // Only `all` reads from the beginning, honouring an explicit offset.
  assert.deepEqual(selectWindow("all", 4096), { offset: 0 });
  assert.deepEqual(selectWindow("all", 4096, 128), { offset: 128 });
});

test("rejects an unusable filter instead of silently matching nothing", () => {
  assert.equal(compileFilter(undefined), undefined);
  assert.equal(compileFilter(""), undefined);
  assert.throws(() => compileFilter("(unclosed"), /Invalid filter pattern/);
  assert.throws(() => compileFilter("x".repeat(1025)), /too long/);
});

test("keeps a filter stateless across the lines it tests", () => {
  const filter = compileFilter("error")!;
  const text = "error one\nerror two\nerror three\n";
  const rendered = renderStream(
    output({ text, size: text.length, nextOffset: text.length }),
    filter,
    0,
  );
  // A `g`-flagged RegExp would carry lastIndex between tests and drop alternating matches.
  assert.match(rendered, /3\/4 lines matched filter/);
  assert.match(rendered, /error one\nerror two\nerror three/);
});

test("reports bytes skipped by a capped resume rather than dropping them silently", () => {
  const rendered = renderStream(
    output({ offset: 9000, nextOffset: 10_000, size: 10_000, text: "tail" }),
    undefined,
    1000,
  );
  assert.match(rendered, /8000 earlier bytes skipped to stay within limit/);
});

test("distinguishes a stream with no output yet from one with nothing new", () => {
  assert.match(renderStream(output({}), undefined, 0), /no output yet/);
  assert.match(
    renderStream(output({ offset: 500, nextOffset: 500, size: 500 }), undefined, 500),
    /no new output/,
  );
});
