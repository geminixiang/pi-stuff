# /// script
# requires-python = ">=3.11"
# ///
"""Measure user↔manager friction from a pi session log (JSONL).

Only messages typed by the user count. Automated user-role messages
(background job notices, loop prompts, task notifications, system reminders)
are excluded.

Metrics, per day and for the whole window:
- human_msgs: user messages typed by the user.
- correction_rate: share of human messages that correct the manager
  (the manager was wrong, skipped verification, broke a rule, lost a task).
- confusion_rate: share asking what something means.
- pull_rate: share asking for status the manager should have pushed
  ("如何了", "好了嗎", "做到哪", "有啥事").
- next_rate: share that are a bare "next" — the user pacing a review queue.
  Neutral, not friction; a rising share means he is driving the queue himself.
- repeat_decision_rate: share of manager replies that re-list pending items
  ("還在等你的") — a proxy for a scattered decision queue.
- over_two_decisions_rate: share of manager replies showing more than two
  `D<n>｜` decisions (the user can only take one or two at a time).
- reply_chars_p50: median length of manager text replies (shorter is easier).
- turns_per_human_msg: manager assistant messages per human message.

Lower is better for every rate. Compare runs over equal-length windows.
"""

import argparse
import json
import re
import statistics
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

AUTOMATED = re.compile(
    r"^(Background job|\[loop |pi-tasks:|<task-notification>|<system-reminder>|System:|The conversation history before this point)"
)
CORRECTION = re.compile(
    r"(不對|錯了|你錯|漏了|弄丟|錯覺|有考證|為什麼不|為啥不|怎麼這樣|倒反|怪怪|不是這樣|沒跟我|兇狠|給我認真|你應該|記得要|需要帶上|不夠|相反|改問|簡短一些|不需要問這麼多|太長|你是不是忘記了|我剛一直以為|^中文[！!。]?$)"
)
CONFUSION = re.compile(r"(什麼意思|是什麼|是指|指的|不懂|看不懂|蛤|聽不懂|什麼是)")
PULL = re.compile(r"^(如何了|好了嗎|做到哪|進度|有啥事|繼續|還有啥)")
NEXT = re.compile(r"^next\s*$", re.I)
PENDING = re.compile(r"還在等你的")
DECISION = re.compile(r"\bD(\d+)[｜|]")


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    return "".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")


def day_of(entry: dict) -> str:
    ts = entry.get("timestamp") or entry.get("message", {}).get("timestamp")
    if isinstance(ts, (int, float)):
        return datetime.utcfromtimestamp(ts / 1000).strftime("%Y-%m-%d")
    return str(ts)[:10] if ts else "unknown"


def rate(n: int, d: int) -> float:
    return round(n / d, 3) if d else 0.0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("session", type=Path)
    ap.add_argument("--since", default="")
    ap.add_argument("--until", default="")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()

    days: dict[str, dict] = defaultdict(lambda: defaultdict(int))
    lengths: dict[str, list[int]] = defaultdict(list)
    for line in args.session.open():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        if e.get("type") != "message":
            continue
        d = day_of(e)
        ts = str(e.get("timestamp") or d)
        if (args.since and ts < args.since) or (args.until and ts >= args.until):
            continue
        m = e["message"]
        t = text_of(m.get("content", "")).strip()
        if m.get("role") == "user":
            if not t or AUTOMATED.match(t):
                continue
            s = days[d]
            s["human_msgs"] += 1
            s["corrections"] += bool(CORRECTION.search(t))
            s["confusions"] += bool(CONFUSION.search(t))
            s["pulls"] += bool(PULL.match(t))
            s["nexts"] += bool(NEXT.match(t))
        elif m.get("role") == "assistant" and t:
            s = days[d]
            s["replies"] += 1
            s["pending_lists"] += bool(PENDING.search(t))
            s["over_two_decisions"] += len(set(DECISION.findall(t))) > 2
            lengths[d].append(len(t))

    def summarize(s: dict, lens: list[int]) -> dict:
        h = s["human_msgs"]
        return {
            "human_msgs": h,
            "correction_rate": rate(s["corrections"], h),
            "confusion_rate": rate(s["confusions"], h),
            "pull_rate": rate(s["pulls"], h),
        "next_rate": rate(s["nexts"], h),
            "repeat_decision_rate": rate(s["pending_lists"], s["replies"]),
        "over_two_decisions_rate": rate(s["over_two_decisions"], s["replies"]),
            "reply_chars_p50": int(statistics.median(lens)) if lens else 0,
            "turns_per_human_msg": rate(s["replies"], h),
        }

    total: dict = defaultdict(int)
    all_lens: list[int] = []
    per_day = {}
    for d in sorted(days):
        per_day[d] = summarize(days[d], lengths[d])
        for k, v in days[d].items():
            total[k] += v
        all_lens += lengths[d]
    report = {"session": str(args.session), "since": args.since, "until": args.until, "total": summarize(total, all_lens), "per_day": per_day}
    out = json.dumps(report, ensure_ascii=False, indent=2)
    print(out)
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        stamp = datetime.utcnow().strftime("%Y%m%dT%H%MZ")
        (args.out / f"friction-{stamp}.json").write_text(out)
        print(f"saved {args.out / f'friction-{stamp}.json'}", file=sys.stderr)


if __name__ == "__main__":
    main()
