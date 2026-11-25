# /// script
# requires-python = ">=3.11"
# ///
"""Measure how well the manager runs other agents.

Sources:
- the manager's pi session log (tool calls to ~/.pi/manager-send.sh)
- the task DB (`.pi/tasks.db`, pi-tasks)
- watcher logs that contain lines `===== tab <n> state=done at <iso>`

Metrics:
- dispatches: messages sent to agent tabs.
- history_reads_per_dispatch: tool calls that read issue/PR history
  (comments, timeline, reviews, issue-context.py) per dispatch. Higher is
  better up to a point; near zero means briefs and decisions were written blind.
- rework_rate: share of sends that correct or redirect an agent's earlier
  work (the brief was incomplete or the agent went the wrong way).
- tabs_used / sends_per_tab: spread of work across tabs.
- dispatch_to_done_p50_min: minutes from a send to that tab's next `done`.
- tasks_created / tasks_closed: task DB rows in the window.
- close_lag_p50_h: hours from created_at to updated_at for done tasks
  (updated_at is the closing write, so this is an upper bound).
- stale_running: tasks still `running`/`todo` untouched for 24 h at run time
  (lost tasks the user may later discover).
- running / running_untouched_7d: `running` should never exceed the number
  of agent tabs; the excess is work nobody is doing (the black hole).

Lower is better for rework_rate, dispatch_to_done, close_lag, stale_running.
"""

import argparse
import glob
import json
import os
import re
import sqlite3
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

SEND = re.compile(r"manager-send\.sh\s+(\d+)\s+(\"[^\"]*\"|'[^']*'|@\S+)")
REWORK = re.compile(r"(使用者 review|不對|修正|拿掉|改成|重寫|更正|方向改|補充：|你那時|漏了|沒照|錯)")
HISTORY = re.compile(r"(issue-context\.(sh|py)|/comments|/timeline|/reviews|gh (issue|pr) view [^|]*--comments)")
DONE = re.compile(r"===== tab (\d+) state=done at (\S+)")


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("session", type=Path)
    ap.add_argument("--tasks-db", type=Path, default=Path(os.environ.get("PI_TASKS_DB", ".pi/tasks.db")))
    ap.add_argument("--watch-logs", default=str(Path.home() / ".pi/bg-bash/logs/*.log"))
    ap.add_argument("--since", default="2026-11-10")
    ap.add_argument("--until")
    args = ap.parse_args()
    since = parse_ts(args.since if "T" in args.since else args.since + "T00:00:00Z")
    until = parse_ts(args.until) if args.until else datetime.now(timezone.utc)

    sends: list[tuple[datetime, str, str]] = []
    history_reads = 0
    for line in args.session.open():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("type") != "message" or e["message"].get("role") != "assistant":
            continue
        ts = e.get("timestamp")
        if not ts:
            continue
        t = parse_ts(ts)
        if not since <= t < until:
            continue
        for c in e["message"].get("content", []):
            if c.get("type") != "toolCall":
                continue
            args_map = c.get("arguments") or {}
            cmd = args_map.get("command") or args_map.get("code") or ""
            history_reads += bool(HISTORY.search(cmd))
            for tab, msg in SEND.findall(cmd):
                body = msg
                if msg.startswith("@"):
                    p = Path(msg[1:])
                    body = p.read_text() if p.exists() else ""
                sends.append((t, tab, body))

    dones: dict[str, list[datetime]] = defaultdict(list)
    for f in glob.glob(args.watch_logs):
        for line in open(f, errors="ignore"):
            m = DONE.search(line)
            if m:
                dones[m.group(1)].append(parse_ts(m.group(2)))
    for v in dones.values():
        v.sort()

    lat = []
    for t, tab, _ in sends:
        nxt = next((d for d in dones.get(tab, []) if d > t), None)
        if nxt and nxt < until and nxt - t < timedelta(hours=12):
            lat.append((nxt - t).total_seconds() / 60)

    per_tab = Counter(tab for _, tab, _ in sends)
    rework = sum(bool(REWORK.search(b)) for _, _, b in sends)

    tasks = {}
    if args.tasks_db.exists():
        db = sqlite3.connect(args.tasks_db)
        rows = db.execute("select status, created_at, updated_at from tasks").fetchall()
        now = datetime.now(timezone.utc)
        created = [r for r in rows if since <= parse_ts(r[1] + "+00:00") < until]
        closed = [r for r in rows if r[0] in ("done", "cancelled") and since <= parse_ts(r[2] + "+00:00") < until]
        lags = [(parse_ts(r[2] + "+00:00") - parse_ts(r[1] + "+00:00")).total_seconds() / 3600 for r in closed if r[0] == "done"]
        stale = [r for r in rows if r[0] in ("running", "todo") and now - parse_ts(r[2] + "+00:00") > timedelta(hours=24)]
        tasks = {
            "tasks_created": len(created),
            "tasks_closed": len(closed),
            "close_lag_p50_h": round(statistics.median(lags), 1) if lags else None,
            "stale_running": len(stale),
            "needs_input": sum(r[0] == "needs_input" for r in rows),
            "running": sum(r[0] == "running" for r in rows),
            "running_untouched_7d": sum(r[0] == "running" and now - parse_ts(r[2] + "+00:00") > timedelta(days=7) for r in rows),
        }

    report = {
        "since": args.since,
        "until": until.isoformat(),
        "dispatches": len(sends),
        "history_reads": history_reads,
        "history_reads_per_dispatch": round(history_reads / len(sends), 2) if sends else 0,
        "rework_rate": round(rework / len(sends), 3) if sends else 0,
        "tabs_used": len(per_tab),
        "sends_per_tab": dict(per_tab.most_common()),
        "dispatch_to_done_p50_min": round(statistics.median(lat), 1) if lat else None,
        "dispatch_to_done_samples": len(lat),
        **tasks,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
