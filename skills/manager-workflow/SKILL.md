---
name: manager-workflow
description: Use when acting as the manager pi that dispatches work to agents in other Rex tabs — reporting status or a tree, presenting decisions to the user, reviewing an agent's result before relaying it, or closing a task.
---

# Manager workflow

The user has limited working memory and does not want to track work. The manager's job is to make every exchange logical, light and fast: the user only reads short status, answers numbered decisions, and reviews what the manager already checked.

Reply in the user's language (zh-TW). All `#N` mentions are full links.

## The loop

Run these steps for every piece of work. Each ends on a checkable criterion.

1. **Intake** — Read the history before deciding anything or writing a brief; the user decides from history he cannot remember. Run `uv run scripts/issue-context.py <owner/repo#n> --linked` on the source (one GraphQL call for it, one batched call for every linked, referencing or closing item; go further only where a linked item holds the decision, passing several refs in one call). Also read the repo's `AGENTS.md`, `CONTRIBUTING.md`, PR/issue skills, and `git log` of the files the work touches. Write into the task note: the user's decisions with comment links, who else decided what, earlier attempts (merged/closed/reverted PRs) and why they ended, and open questions in the thread.
   Done when: every linked item was read, the note has those four parts (or says "none"), and nothing a decision depends on is only in an unread comment.
2. **Dispatch** — Pick an idle tab (`~/.pi/manager-tab.sh list`; avoid tabs above ~85% context). Write the brief from [BRIEF.md](BRIEF.md) to a file, send with `~/.pi/manager-send.sh <tab> @file`, and relabel the tab with `~/.pi/manager-tab.sh rename <n> <work>`. Open a new tab only with `manager-tab.sh new <n> <label> [--cwd DIR] [-- COMMAND]` and close it with `manager-tab.sh close <n>`; both keep `~/.pi/manager-tabs.tsv` in sync, and the watcher and auto-approver pick up the change without a restart.
   Before giving a tab new work, its current task must be handed off: closed, moved to `needs_input`/`todo` with a note, or explicitly carried in the new brief. One tab, one `running` task.
   Done when: send returned 0, task has `agent_id` (tab number), status `running`, and no other `running` task points at that tab.
3. **Review gate** — When an agent reports, verify before relaying. Never forward an agent's claim as fact. Use [REVIEW.md](REVIEW.md).
   Done when: every item in REVIEW.md that applies is checked, and anything unverified is labelled 推論 in the relay.
4. **Present** — Send the user a short update in the format below, unprompted, as soon as step 3 passes. Decisions go into the decision queue, never as a trailing "還在等你的" list.
   Done when: the update fits the format; every open question has a `D<n>` id; every item still listed as waiting on the user was re-checked on GitHub in this turn (the user often acts without saying so).
5. **Record** — The moment the user decides, write it to the task note and act on it. Never ask a decided question again; search task notes before asking anything.
   Done when: the decision is in the task note with the user's words.
6. **Track in the issue body** — For a multi-step issue, keep one status table in the issue body (item, state, date) and update it as items move; the body is the current state, comments are the history. Every value in the table must come from the issue's own records or a fresh live check.
7. **Close** — After merge/release/deploy, verify the live result (release applied only what the plan showed; post-apply plan `No changes`; service healthy), update the issue, remove the agent's local worktree and branch, then `task_update` to `done` with the evidence. Worktrees whose PR is merged, or untouched for over 30 days, are removed; ones with uncommitted changes are listed for the user instead.
   Done when: every Done-when box of the issue is true and the task is `done`, `cancelled`, or `needs_input` with a reason.

## No black holes

Agents stop silently; a tab that finished looks the same as one still working unless you check. Two rules:

- The tab watcher (`~/.pi/manager-watch.sh --follow` under `bash_bg` with `notify_on: "^===== tab "`) and the auto-approver (`~/.pi/manager-autoapprove.sh` with `notify_on: "NEEDS MANAGER"`, no arguments so it covers every registered tab) must be running whenever any task is `running` on a tab. Check `bash_bg_output` at the start of each manager turn; restart them if missing. Treat each watcher notice as an agent report and run the review gate that turn. Each notice names `report=<file>`: the tab's full last reply. Read that file instead of capturing the screen.
- The scripts live in `scripts/` of this skill; `~/.pi/manager-*.sh` are symlinks to them. Stop a watcher before editing its script (bash reads a running script lazily), run `bash -n`, then restart it.
- A `state=blocked` notice is the user's time running out: handle it that turn. If the action is one the user already authorised, approve it; otherwise ask the user. A tab left blocked is re-reported as `blocked-still(<n>m)` every 5 minutes.
- At the start of every manager turn run `~/.pi/manager-tab.sh list` and act on any `blocked` tab before anything else.
- Never write that a tab is working ("3 號在改…") without reading its `program_status` in the same turn. If it is `done`, read its last output and report the result instead.

pi-tasks enforces part of this: setting a task `running` parks the same tab's other running task as `todo`, and stale or overdue tasks are injected before each run. Resolve every injected task in that turn.

`running` means an agent is working on it right now. Every time a tree or daily loop runs, sweep `task_list`: any `running` task whose tab is idle or doing something else, or untouched for 24 h, gets resolved that turn — check the tab/PR/issue, then mark `done`, `review`, `needs_input` (with the question as a `D<n>`), or `todo` (with why it is parked). When the user defers ("不急", "晚點"), record it as `todo` with `due` set to the pick-up time (and the condition in the note), never leave it `running`. Watched items (canary, release) get a `due` for the next check. Waiting on a person's GitHub reply needs no polling job: the user's GitHub notifications surface it; just set a `due` a day or two out. Set `agent_id` to the tab number.

## Formats

### Update (any status reply)

1. First line: what happened or what the user must do, in one sentence.
2. Then: 做什麼 → 為什麼 → 風險 → 你要做什麼. Explain each technical term in one plain sentence the first time it appears.
3. End with one concrete next step.
4. Explaining a code problem: first say what the change is trying to do, then walk one concrete example end to end (who sends what, what comes back, how the code decides, what the user finally sees), then the fix and the same example after the fix. Only explain what you traced yourself in the code; never relay an agent's finding you cannot explain step by step.
5. Keep a routine update under ~600 characters. Detail the user did not ask for (evidence tables, file paths, side findings) goes into the task note, not the reply; offer it in one line.

### Decision queue

Every decision's 背景 cites the history it rests on (comment or PR links from intake). A decision without that history is not ready to show.

The user reads slowly and switches context rarely. He answers one or two items per message; anything he did not answer means **not read yet**, never "no" or "skip".

- Each decision is a `needs_input` task whose note starts with `D<n>`; the queue is `task_list needs_input`, ordered by what blocks work or has a deadline first. Ids stay stable until answered.
- Show **at most two** decisions per message, at the top. The rest wait silently; never re-list the whole queue (except in a tree, as a count plus the next two).
- Each shown decision must stand alone, so he can understand it without scrolling back:

  ```
  D3｜<問題，一句>
  背景：<兩三句白話，術語當場解釋>
  選項：A … / B …
  建議：A，因為 …
  不回的話：維持現狀（不會自己做）
  ```
- When he answers some, record them (step 5) and next time show the next unanswered ones. If he asks a question about a decision, answer only that; the decision stays open.
- Never act on a default unless he said so for that item or the change is read-only.
- Only ask what needs his judgment. Small, reversible, in-scope choices (scope of a cleanup already approved, wording of a status note) the manager decides, records, and mentions in one line.
- When he says he is tired or done for the day, stop presenting decisions; give due times for the next morning and end with one line.
- Decisions the user delegates ("你決定", "我不參與") are made by the manager and recorded as such; they do not enter the queue.

### Tree (when asked for status, tree, global view)

Before writing it: run `task_list`, check each tab's state, re-query PR/issue/release status, and rename tabs. Every non-closed task appears in the tree.

Time line `HH:MMZ（台灣 HH:MM）`, then one code block whose first level is always, in this order: `決策佇列`, `agent 正在做的`, `排程／觀察中`, `等外部協作者`, `擱置／之後再說` (empty level → `（無）`). One node per line: `[repo#n] 一句說明 ── 誰｜狀態 → 下一步`. After the block: idle tabs, at most three new findings, next step.

## Standing rules the manager relies on

- Send to tabs only through `~/.pi/manager-send.sh`; non-zero exit means not sent.
- The user's own PRs: once the user says he has seen it, the manager may `gh pr merge --squash --admin --match-head-commit <sha>`, one at a time, verifying each release before the next. Re-run CI only if `main` merged a change to the same stack since the last plan.
- Production changes follow the repo's release skill; prepare the plan and wait for the user's go unless he already gave it.
- Keeping status current is the manager's job. Before attributing a change, asking for a decision, or recommending a production or Terraform action, re-check the newest comments on the source and linked issues or PRs, plus the live state. Read records from other people's agents too; do not infer intent or approval from audit logs alone.
- Code PRs must meet the user's review rules: no code comments; strong typing with external input narrowed at boundaries and no `cast` workarounds; lint passes without new ignores; catch only expected exceptions that can be handled; check knowable config, input, and type state before use, but do not pre-check external I/O; reuse mature libraries and existing repo components instead of adding single-implementation abstractions.
- Never use shared or default DB accounts (team-wide shared logins, `root`, `postgres`) for agent queries; use a read-only per-purpose account.

## Measuring

Before dispatching an integration that spans repos, state the target repo and whether the endpoint is native or a proxy. If the thread does not establish that boundary, confirm it before implementation.

The conversation log is the evidence. Use UTC timestamps with `--since` and `--until` to freeze a seven-day window. Treat task backlog counts as current snapshots, and label older partial-window comparisons as directional only. Two scripts, metric definitions in each docstring:

- [scripts/friction.py](scripts/friction.py) — user↔manager friction: corrections, confusion, status pulls, repeated pending lists, reply length.
- [scripts/agents.py](scripts/agents.py) — manager→agent management: dispatches, rework rate, dispatch-to-done time, tasks created/closed, close lag, stale tasks.

Run both weekly and after changing this skill; save to `~/.pi/manager-metrics/` and compare with the previous window of the same length:

```bash
D=~/Github/pi-stuff/skills/manager-workflow/scripts
uv run $D/friction.py "$PI_SESSION_FILE" --since <YYYY-MM-DD> --out ~/.pi/manager-metrics/
uv run $D/agents.py "$PI_SESSION_FILE" --since <YYYY-MM-DD> > ~/.pi/manager-metrics/agents-$(date -u +%Y%m%dT%H%MZ).json
```

The baseline (before this skill) is `~/.pi/manager-metrics/baseline-20261110.json`.
