import assert from "node:assert/strict";
import { mkdtempSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recordPath, writeRecord } from "../extensions/index.ts";
import {
  capture,
  describe,
  missingPiSessions,
  readSnapshot,
  restore,
  startupInput,
  writeSnapshot,
} from "../src/rex-snap.mjs";

const SID = "session:01a1-s";

// One session, two windows: "main" split top/bottom (pi on top, shell below),
// and a default-labelled window running a dev server.
const layoutMain = {
  split: {
    direction: "vertical",
    ratio: 0.7,
    before: { block_id: "block:01a1-pi" },
    after: { block_id: "block:01a1-sh" },
  },
};
const processes: Record<string, unknown> = {
  "block:01a1-pi": { foreground: { pid: 100, argv0: "pi", name: "node", cwd: "/repo" } },
  "block:01a1-sh": { foreground: { pid: 101, argv0: "-zsh", name: "zsh", cwd: "/home" } },
  "block:01a1-dev": { foreground: { pid: 102, argv0: "npm", name: "node", cwd: "/repo/web" } },
};

function fakeRex(args: string[]): string {
  const key = args.join(" ");
  if (key === "ls --json")
    return JSON.stringify({ sessions: [{ session_id: SID, label: "work" }] });
  if (key === `window ls --json -s ${SID}`)
    return JSON.stringify({
      active_window_id: "window:2",
      windows: [
        { window_id: "window:1", label: "main", layers: [{ kind: "tiled", layout: layoutMain }] },
        {
          window_id: "window:2",
          label: "Window 3e80c2ea",
          layers: [{ kind: "tiled", layout: { block_id: "block:01a1-dev" } }],
        },
      ],
    });
  if (args[0] === "block" && args.at(-1) === "process") return JSON.stringify(processes[args[5]]);
  throw new Error(`unexpected rex ${key}`);
}

function captureWith(recordDir: string) {
  return capture({ rex: fakeRex, recordDir, argsOf: (pid) => (pid === 102 ? "npm run dev" : "") });
}

test("capture records layout, cwd, programs and pi sessions with a matching pid", () => {
  const dir = mkdtempSync(join(tmpdir(), "rex-pi-"));
  writeRecord(
    {
      block: "block:01a1-pi",
      rexSession: SID,
      sessionFile: "/s/a b.jsonl",
      sessionId: "abc",
      cwd: "/repo",
      pid: 100,
      updatedAt: "",
    },
    dir,
  );
  assert.equal(recordPath("block:01a1-pi", dir), join(dir, "01a1-pi.json"));

  const snap = captureWith(dir);
  const [main, dev] = snap.sessions[0].windows;
  assert.equal(snap.sessions[0].label, "work");
  assert.deepEqual([main.active, dev.active], [false, true]);
  assert.ok("direction" in main.layout);
  assert.equal(main.layout.ratio, 0.7);
  assert.deepEqual(main.layout.before, {
    pane: {
      block: "block:01a1-pi",
      cwd: "/repo",
      kind: "pi",
      piSessionFile: "/s/a b.jsonl",
      piSessionId: "abc",
    },
  });
  assert.deepEqual(main.layout.after, {
    pane: { block: "block:01a1-sh", cwd: "/home", kind: "shell" },
  });
  assert.deepEqual(dev.layout, {
    pane: { block: "block:01a1-dev", cwd: "/repo/web", kind: "program", command: "npm run dev" },
  });
  assert.equal(missingPiSessions(snap), 0);
});

test("a pi record from an earlier process is ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "rex-pi-"));
  writeRecord(
    {
      block: "block:01a1-pi",
      rexSession: SID,
      sessionFile: "/s/old.jsonl",
      sessionId: "old",
      cwd: "/repo",
      pid: 99,
      updatedAt: "",
    },
    dir,
  );
  const snap = captureWith(dir);
  assert.equal(missingPiSessions(snap), 1);
  assert.match(describe(snap), /pi \?\?\?/);
  assert.match(describe(snap), /Run \/reload/);
});

test("restore rebuilds windows and splits, then reopens pi and types programs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rex-pi-"));
  writeRecord(
    {
      block: "block:01a1-pi",
      rexSession: SID,
      sessionFile: "/s/a b.jsonl",
      sessionId: "abc",
      cwd: "/repo",
      pid: 100,
      updatedAt: "",
    },
    dir,
  );
  const snap = captureWith(dir);

  const calls: string[][] = [];
  let n = 0;
  const rex = (args: string[]) => {
    calls.push(args);
    if (args[0] === "ls") return JSON.stringify({ sessions: [{ label: "work" }] });
    n++;
    if (args[0] === "new")
      return JSON.stringify({
        session_id: "session:new",
        initial_windows: [{ block_ids: [`block:b${n}`] }],
      });
    return JSON.stringify({ block_ids: [`block:b${n}`] });
  };
  await restore(snap, { rex, settleMs: 0 });

  assert.deepEqual(calls.slice(1), [
    ["new", "work-restored", "--cwd", "/repo", "--window", "main", "--json"],
    [
      "split",
      "-s",
      "session:new",
      "-b",
      "block:b1",
      "--split",
      "below",
      "--ratio",
      "30",
      "--cwd",
      "/home",
      "--focus=false",
      "--json",
    ],
    ["window", "new", "-s", "session:new", "--cwd", "/repo/web", "--focus=true", "--json"],
    ["send", "-s", "session:new", "-b", "block:b1", "pi --session '/s/a b.jsonl'\n"],
    ["send", "-s", "session:new", "-b", "block:b3", "npm run dev"],
  ]);
});

test("dry run issues nothing but ls", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rex-pi-"));
  const snap = captureWith(dir);
  const calls: string[][] = [];
  const issued = await restore(snap, {
    dryRun: true,
    rex: (args) => {
      calls.push(args);
      return JSON.stringify({ sessions: [] });
    },
  });
  assert.deepEqual(calls, [["ls", "--json"]]);
  assert.equal(issued[0][1], "work");
  assert.ok(issued.some((a) => a.at(-1) === "pi -r"));
});

test("startupInput never executes non-pi programs", () => {
  assert.equal(
    startupInput({ block: "b", cwd: "/", kind: "program", command: "rm -rf build" }),
    "rm -rf build",
  );
  assert.equal(startupInput({ block: "b", cwd: "/", kind: "shell" }), undefined);
});

test("writeSnapshot points latest.json at the newest file", () => {
  const dir = mkdtempSync(join(tmpdir(), "rex-snap-"));
  const snap = { savedAt: "2026-10-21T03:24:12.000Z", sessions: [] };
  assert.equal(writeSnapshot(snap, dir), join(dir, "20261021-032412.json"));
  assert.equal(readlinkSync(join(dir, "latest.json")), "20261021-032412.json");
  assert.deepEqual(readSnapshot(join(dir, "latest.json")), snap);
});
