// @ts-check
// Snapshot and restore Rex sessions, including the pi session running in each pane.
// Shared by the `rex-snap` CLI and the `/rex-snap` pi command.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * @typedef {{ block: string; cwd: string | null; kind: "shell" | "pi" | "program"; command?: string; piSessionFile?: string; piSessionId?: string }} Pane
 * @typedef {{ pane: Pane } | { direction: "vertical" | "horizontal"; ratio: number; before: Layout; after: Layout }} Layout
 * @typedef {{ label: string; active: boolean; layout: Layout }} SnapWindow
 * @typedef {{ label: string; windows: SnapWindow[] }} SnapSession
 * @typedef {{ savedAt: string; sessions: SnapSession[] }} Snapshot
 * @typedef {(args: string[]) => string} RexRunner
 */

const STATE_DIR = join(homedir(), ".local", "state");
export const SNAP_DIR = join(STATE_DIR, "rex-snap");
export const PI_RECORD_DIR = join(STATE_DIR, "rex-pi");

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "nu", "xonsh", "login"]);

/** @type {RexRunner} */
export function defaultRunner(args) {
  return execFileSync("rex", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** @param {string} id */
export function shortId(id) {
  return id.replace(/^[a-z]+:/, "");
}

/** @param {string} label */
function isDefaultWindowLabel(label) {
  return /^Window [0-9a-f]{8}$/.test(label);
}

/** @param {string} name */
function isShell(name) {
  return SHELLS.has(basename(name).replace(/^-/, ""));
}

/** @param {number} pid */
function processArgs(pid) {
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * The pi extension writes `<block>.json`. Trust it only when its pid is the
 * pane's current foreground pid, so a record from an earlier pi is ignored.
 * @param {string} recordDir @param {string} blockId @param {number | undefined} pid
 */
function readPiRecord(recordDir, blockId, pid) {
  const file = join(recordDir, `${shortId(blockId)}.json`);
  if (!existsSync(file)) return undefined;
  try {
    const rec = JSON.parse(readFileSync(file, "utf8"));
    return rec.pid === pid ? rec : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param {{ rex?: RexRunner; recordDir?: string; argsOf?: (pid: number) => string }} [opts]
 * @returns {Snapshot}
 */
export function capture(opts = {}) {
  const run = opts.rex ?? defaultRunner;
  const recordDir = opts.recordDir ?? PI_RECORD_DIR;
  const argsOf = opts.argsOf ?? processArgs;
  /** @param {string[]} args */
  const rexJson = (args) => JSON.parse(run(args));

  /** @param {string} sid @param {string} blockId @returns {Pane} */
  const describePane = (sid, blockId) => {
    const proc = rexJson(["block", "call", "-s", sid, "-b", blockId, "process"]);
    const fg = proc.foreground ?? {};
    /** @type {Pane} */
    const pane = { block: blockId, cwd: fg.cwd ?? null, kind: "shell" };
    if (!pane.cwd)
      pane.cwd = rexJson(["block", "call", "-s", sid, "-b", blockId, "pwd"]).path ?? null;
    const name = fg.argv0 || fg.name || "";
    if (!fg.pid || isShell(name)) return pane;
    if (name === "pi" || basename(fg.invoked_path ?? "") === "pi") {
      pane.kind = "pi";
      const rec = readPiRecord(recordDir, blockId, fg.pid);
      if (rec) {
        pane.piSessionFile = rec.sessionFile;
        pane.piSessionId = rec.sessionId;
        pane.cwd = rec.cwd || pane.cwd;
      }
      return pane;
    }
    pane.kind = "program";
    pane.command = argsOf(fg.pid) || name;
    return pane;
  };

  /** @param {string} sid @param {any} node @returns {Layout} */
  const describeLayout = (sid, node) => {
    if (node.block_id) return { pane: describePane(sid, node.block_id) };
    const s = node.split;
    return {
      direction: s.direction,
      ratio: s.ratio,
      before: describeLayout(sid, s.before),
      after: describeLayout(sid, s.after),
    };
  };

  /** @type {Snapshot} */
  const snap = { savedAt: new Date().toISOString(), sessions: [] };
  for (const sess of rexJson(["ls", "--json"]).sessions) {
    const detail = rexJson(["window", "ls", "--json", "-s", sess.session_id]);
    /** @type {SnapWindow[]} */
    const windows = [];
    for (const w of detail.windows) {
      const tiled = w.layers.find((/** @type {any} */ l) => l.kind === "tiled");
      if (!tiled) continue;
      windows.push({
        label: w.label,
        active: w.window_id === detail.active_window_id,
        layout: describeLayout(sess.session_id, tiled.layout),
      });
    }
    snap.sessions.push({ label: sess.label, windows });
  }
  return snap;
}

/** @param {Layout} layout @returns {Generator<Pane>} */
export function* panes(layout) {
  if ("pane" in layout) yield layout.pane;
  else {
    yield* panes(layout.before);
    yield* panes(layout.after);
  }
}

/** @param {Layout} layout */
function firstPane(layout) {
  return panes(layout).next().value;
}

/** @param {Snapshot} snap */
export function missingPiSessions(snap) {
  let n = 0;
  for (const s of snap.sessions)
    for (const w of s.windows)
      for (const p of panes(w.layout)) if (p.kind === "pi" && !p.piSessionId) n++;
  return n;
}

/** @param {Snapshot} snap @returns {string} */
export function describe(snap) {
  const lines = [`snapshot ${snap.savedAt}`];
  for (const s of snap.sessions) {
    lines.push(`session ${s.label}`);
    s.windows.forEach((w, i) => {
      lines.push(`  window ${i + 1} ${w.label}${w.active ? " *" : ""}`);
      for (const p of panes(w.layout)) {
        let extra = "";
        if (p.kind === "pi")
          extra = `pi ${p.piSessionId ?? "??? (unknown session, will open the picker)"}`;
        else if (p.kind === "program") extra = `[typed, not run] ${p.command}`;
        lines.push(`    ${p.cwd ?? "?"}  ${extra}`.trimEnd());
      }
    });
  }
  const missing = missingPiSessions(snap);
  if (missing)
    lines.push(
      "",
      `${missing} pi pane(s) have no session id. Run /reload in those pi sessions, then save again.`,
    );
  return lines.join("\n");
}

/** @param {Snapshot} snap @param {string} [dir] @returns {string} path */
export function writeSnapshot(snap, dir = SNAP_DIR) {
  mkdirSync(dir, { recursive: true });
  const stamp = snap.savedAt.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const path = join(dir, `${stamp}.json`);
  writeFileSync(path, `${JSON.stringify(snap, null, 2)}\n`);
  const latest = join(dir, "latest.json");
  rmSync(latest, { force: true });
  symlinkSync(basename(path), latest);
  return path;
}

/** @param {string} [path] @returns {Snapshot} */
export function readSnapshot(path = join(SNAP_DIR, "latest.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** @param {Pane} pane @returns {string | undefined} */
export function startupInput(pane) {
  if (pane.kind === "pi" && pane.piSessionFile)
    return `pi --session ${shellQuote(pane.piSessionFile)}\n`;
  if (pane.kind === "pi") return "pi -r"; // unknown session: let the user confirm the picker
  if (pane.kind === "program") return pane.command; // typed, never executed
  return undefined;
}

/** @param {string} s */
function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Recreate every session in the snapshot. Commands are returned in order; with
 * dryRun nothing is executed.
 * @param {Snapshot} snap
 * @param {{ rex?: RexRunner; dryRun?: boolean; settleMs?: number }} [opts]
 * @returns {Promise<string[][]>}
 */
export async function restore(snap, opts = {}) {
  const run = opts.rex ?? defaultRunner;
  const dry = opts.dryRun ?? false;
  /** @type {string[][]} */
  const issued = [];
  let fakeId = 0;
  /** @param {string[]} args */
  const create = (args) => {
    issued.push(args);
    if (dry) {
      fakeId++;
      return {
        session_id: `session:dry${fakeId}`,
        block_ids: [`block:dry${fakeId}`],
        initial_windows: [{ block_ids: [`block:dry${fakeId}`] }],
      };
    }
    return JSON.parse(run(args));
  };

  /** @param {string} sid @param {Layout} layout @param {string} block @returns {[string, string, Pane][]} */
  const build = (sid, layout, block) => {
    if ("pane" in layout) return [[sid, block, layout.pane]];
    const after = firstPane(layout.after);
    const res = create([
      "split",
      "-s",
      sid,
      "-b",
      block,
      "--split",
      layout.direction === "vertical" ? "below" : "right",
      "--ratio",
      String(Math.round((1 - layout.ratio) * 100)),
      ...(after.cwd ? ["--cwd", after.cwd] : []),
      "--focus=false",
      "--json",
    ]);
    return [...build(sid, layout.before, block), ...build(sid, layout.after, res.block_ids[0])];
  };

  const existing = new Set(
    JSON.parse(run(["ls", "--json"])).sessions.map((/** @type {any} */ s) => s.label),
  );
  /** @type {[string, string, Pane][]} */
  const todo = [];
  for (const s of snap.sessions) {
    const label = existing.has(s.label) ? `${s.label}-restored` : s.label;
    /** @type {string | undefined} */
    let sid;
    for (const w of s.windows) {
      const cwd = firstPane(w.layout).cwd;
      const cwdArgs = cwd ? ["--cwd", cwd] : [];
      const named = !isDefaultWindowLabel(w.label);
      let block;
      if (!sid) {
        const res = create([
          "new",
          label,
          ...cwdArgs,
          ...(named ? ["--window", w.label] : []),
          "--json",
        ]);
        sid = /** @type {string} */ (res.session_id);
        block = res.initial_windows[0].block_ids[0];
      } else {
        const res = create([
          "window",
          "new",
          "-s",
          sid,
          ...(named ? [w.label] : []),
          ...cwdArgs,
          `--focus=${w.active}`,
          "--json",
        ]);
        block = res.block_ids[0];
      }
      todo.push(...build(sid, w.layout, block));
    }
  }

  if (!dry && todo.length) await new Promise((r) => setTimeout(r, opts.settleMs ?? 1000)); // let shells start
  for (const [sid, block, pane] of todo) {
    const input = startupInput(pane);
    if (!input) continue;
    const args = ["send", "-s", sid, "-b", block, input];
    issued.push(args);
    if (!dry) run(args);
  }
  return issued;
}
