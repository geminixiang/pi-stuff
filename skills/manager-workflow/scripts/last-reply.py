#!/usr/bin/env python3
"""Print the full last assistant reply of the pi session shown on a terminal screen.

Reads the screen text on stdin, scans pi session files modified in the last
--minutes, and prints the last assistant message of the session whose reply
contains the most screen lines. Exits 1 when no session matches.
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

SESSIONS = Path.home() / ".pi" / "agent" / "sessions"
BOX = re.compile(r"[│┌┐└┘├┤┬┴┼─━]")
NOISE = re.compile(r"[\s*`#>|_\-•·…]+")
CHROME = re.compile(r"^\s*(─|~/|↑|Elapsed|Background:|bg:|TPS |Took |\$ |↳|●|└─)|Option\+Up|\(cliproxyapi\)|Working ─")


def normalize(text: str) -> str:
    return NOISE.sub("", text)


def last_reply(path: Path) -> str:
    reply = ""
    with path.open(encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if '"assistant"' not in line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = entry.get("message") or {}
            if entry.get("type") != "message" or message.get("role") != "assistant":
                continue
            content = message.get("content")
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                text = "".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text")
            else:
                text = ""
            if text.strip():
                reply = text
    return reply


def screen_keys(screen: str) -> list[str]:
    keys = []
    for line in screen.splitlines():
        if CHROME.search(line) or BOX.search(line):
            continue
        key = normalize(line)
        if len(key) >= 2:
            keys.append(key[:60])
    return keys[-12:]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--minutes", type=float, default=1440)
    args = parser.parse_args()
    keys = screen_keys(sys.stdin.read())
    if not keys:
        return 1
    cutoff = time.time() - args.minutes * 60
    best: tuple[int, float, str] | None = None
    for path in SESSIONS.glob("*/*.jsonl"):
        mtime = path.stat().st_mtime
        if mtime < cutoff:
            continue
        reply = last_reply(path)
        if not reply:
            continue
        flat = normalize(reply)
        if keys[-1] not in flat[-(len(keys[-1]) + 30):]:
            continue
        score = sum(1 for key in keys if key in flat)
        if score and (best is None or (score, mtime) > (best[0], best[1])):
            best = (score, mtime, reply)
    if best is None:
        return 1
    sys.stdout.write(best[2].rstrip() + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
