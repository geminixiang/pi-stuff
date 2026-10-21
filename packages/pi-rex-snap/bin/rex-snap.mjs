#!/usr/bin/env node
// @ts-check
import {
  capture,
  describe,
  missingPiSessions,
  readSnapshot,
  restore,
  writeSnapshot,
} from "../src/rex-snap.mjs";

const USAGE = `rex-snap — snapshot and restore Rex sessions with their pi sessions

  rex-snap save                     save ~/.local/state/rex-snap/<time>.json (+ latest.json)
  rex-snap show [FILE]              print a snapshot
  rex-snap restore [FILE] [--dry-run]
                                    recreate sessions, windows and splits, cd to each
                                    pane's directory and reopen pi with \`pi --session\``;

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const [cmd, file] = argv.filter((a) => a !== "--dry-run");

try {
  if (cmd === "save") {
    const snap = capture();
    console.log(`saved ${writeSnapshot(snap)}\n${describe(snap)}`);
    if (missingPiSessions(snap)) process.exitCode = 2;
  } else if (cmd === "show") {
    console.log(describe(readSnapshot(file)));
  } else if (cmd === "restore") {
    const issued = await restore(readSnapshot(file), { dryRun });
    if (dryRun)
      for (const a of issued) console.log(`rex ${a.map((x) => JSON.stringify(x)).join(" ")}`);
    else console.log(`restored (${issued.length} rex commands)`);
  } else {
    console.log(USAGE);
    if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exitCode = 1;
  }
} catch (error) {
  const e = /** @type {any} */ (error);
  console.error(`rex-snap: ${e?.stderr?.toString().trim() || e?.message || e}`);
  process.exitCode = 1;
}
