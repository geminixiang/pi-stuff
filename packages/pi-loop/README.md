# pi-loop

Recurring prompts inside a pi session, modeled on Claude Code's `/loop`.

```text
/loop 5m check whether the deployment finished    # fixed interval (min 1m, rounded up to minutes)
/loop every 2h summarize new PR activity
/loop check CI and fix failures                   # self-paced: agent calls loop_next to pick 1m–60m
/loop                                             # self-paced maintenance prompt
/loop --raw 5m ping                                # skip refinement, schedule verbatim
/loop edit [id] 別再貼完整 log                     # agent reviews past runs and revises the loop in place
/loop list
/loop stop <id|all>
```

- By default `/loop` spends one agent turn rewriting your prompt into a self-contained one
  (inlines repo/PR/commands from the conversation, adds a done condition), then the agent calls `loop_create`.
  Use `--raw` to skip.
- Jobs fire only while pi is running **and idle**; they never interrupt a turn and missed ticks are not replayed.
- Up to 50 loops; each expires after 7 days (with one final run).
- Fixed-interval loops are persisted in the session and restored on `--resume`/`--continue`; self-paced loops are not.
- Default prompt: `.pi/loop.md` in the project, then `~/.pi/agent/loop.md`, then a built-in maintenance prompt.
- Tune a loop after a few runs with `/loop edit`, or just ask in plain words ("把這個 loop 改成每 30 分鐘").
  The agent reads the full prompt (`loop_list` with id) and rewrites it via `loop_update`, keeping id, run count and expiry.
- Agent tools: `loop_create`, `loop_list`, `loop_update`, `loop_delete`, `loop_next`.
