import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PI_RECORD_DIR,
  capture,
  describe,
  readSnapshot,
  restore,
  shortId,
  writeSnapshot,
} from "../src/rex-snap.mjs";

/** Contents of `~/.local/state/rex-pi/<block>.json`. */
export interface PiRecord {
  block: string;
  rexSession: string | undefined;
  sessionFile: string;
  sessionId: string;
  cwd: string;
  pid: number;
  updatedAt: string;
}

export function recordPath(block: string, dir = PI_RECORD_DIR): string {
  return join(dir, `${shortId(block)}.json`);
}

export function writeRecord(record: PiRecord, dir = PI_RECORD_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(recordPath(record.block, dir), `${JSON.stringify(record, null, 2)}\n`);
}

const USAGE = "Usage: /rex-snap save | show | restore [--dry-run]";

export default function rexSnap(pi: ExtensionAPI) {
  const block = process.env.REX_BLOCK;

  // Record which pi session runs in this Rex pane. Fires on startup, /reload,
  // /new, /resume and fork. There is no cleanup on shutdown on purpose: a dying
  // Rex server kills pi too, and the record must survive that. Readers compare
  // the pid to discard stale records.
  if (block) {
    pi.on("session_start", async (_event, ctx) => {
      const sm = ctx.sessionManager;
      const sessionFile = sm.getSessionFile();
      if (!sessionFile) return; // --no-session
      writeRecord({
        block,
        rexSession: process.env.REX_SESSION,
        sessionFile,
        sessionId: sm.getSessionId(),
        cwd: sm.getCwd(),
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      });
    });
  }

  pi.registerCommand("rex-snap", {
    description: "Save, show, or restore a snapshot of Rex sessions and their pi sessions",
    handler: async (args, ctx) => {
      const [action, ...rest] = args.trim().split(/\s+/);
      try {
        if (action === "save") {
          const snap = capture();
          const path = writeSnapshot(snap);
          ctx.ui.notify(`Saved ${path}\n${describe(snap)}`, "info");
        } else if (action === "show") {
          ctx.ui.notify(describe(readSnapshot()), "info");
        } else if (action === "restore") {
          const issued = await restore(readSnapshot(), { dryRun: rest.includes("--dry-run") });
          ctx.ui.notify(
            issued.map((a) => `rex ${a.join(" ")}`).join("\n") || "Nothing to restore",
            "info",
          );
        } else {
          ctx.ui.notify(USAGE, "warning");
        }
      } catch (error) {
        ctx.ui.notify(
          `rex-snap failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
