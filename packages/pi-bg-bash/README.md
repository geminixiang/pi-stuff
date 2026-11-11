# @geminixiang/pi-bg-bash

Run long shell commands in the background so you can keep talking to pi while they run. When a job exits, pi posts its exit code and the tail of its output to the session and gives the agent a turn to react. Jobs can also wake the agent while they run (`notify_on`, `idle_warn`), wait for a condition (`wait_until`), start later (`at`), and survive `/reload`.

## Tools

| Tool             | What it does                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `bash_bg`        | Start a job (or schedule it) and return a job id right away                                                          |
| `bash_bg_output` | Without `id`, list running, scheduled and recently finished jobs. With `id`, show status and the last `lines` of output |
| `bash_bg_kill`   | Stop a job (or `all`): SIGTERM to its process group, SIGKILL after 5 seconds. Scheduled jobs are cancelled            |

### `bash_bg` parameters

| Parameter      | Default    | Meaning                                                                                                                  |
| -------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `command`      | required   | Shell command, run with `bash -c`. With `wait_until`, the check to repeat                                                |
| `label`        |            | Short name shown in lists and the footer                                                                                 |
| `cwd`          | session    | Working directory (relative paths resolve against the session cwd)                                                       |
| `timeout`      |            | Kill the job after this many seconds                                                                                     |
| `notify`       | `true`     | Post messages and wake the agent                                                                                         |
| `notify_on`    |            | Regex. Matching output lines wake the agent while the job keeps running                                                  |
| `idle_warn`    |            | Seconds without new output before one "no output for …" message; re-arms after new output                                |
| `wait_until`   | `false`    | Run `command` every `interval` seconds until it exits 0 (exit 0) or `max_wait` passes (exit 124)                          |
| `interval`     | `30`       | Seconds between `wait_until` checks                                                                                      |
| `max_wait`     | `3600`     | Seconds before `wait_until` gives up                                                                                     |
| `at`           |            | Start later: ISO-8601 time or relative `+90s`, `+10m`, `+2h`, `+1h30m`                                                   |
| `env`          |            | Extra or overriding environment variables                                                                                |
| `fail_on`      |            | Regex. A matching output line kills the job. `""` disables the built-in patterns                                         |
| `builtin_fail` | `true`     | Use the built-in auth-failure patterns. Set `false` for jobs that relay other programs' output (watchers/monitors)        |
| `preflight`    |            | Command run first; if it exits non-zero the job does not start and its output is reported                                |
| `ok_codes`     | `[0]`      | Exit codes that count as success                                                                                         |
| `yield_ms`     |            | Wait up to this many ms (max 60000) for the job to exit; see [Yield](#yield). Not allowed with `wait_until` or `at`       |

Examples:

```jsonc
// command, label, cwd
{ "command": "npm run build", "label": "build", "cwd": "web" }
// timeout
{ "command": "terraform apply -auto-approve", "timeout": 1800 }
// notify: false (fire and forget; check with bash_bg_output)
{ "command": "rsync -a src/ backup/", "notify": false }
// notify_on: one long-lived watcher instead of a script that exits per event
{ "command": "./watch-agents.sh", "notify_on": "^(DONE|FAILED) " }
// idle_warn: tell me if the poller goes quiet for 10 minutes
{ "command": "./poll-build.sh", "idle_warn": 600 }
// wait_until + interval + max_wait
{ "command": "gh pr view 123 --json state -q .state | grep -q MERGED", "wait_until": true, "interval": 60, "max_wait": 7200 }
// at (relative or absolute)
{ "command": "./hourly-check.sh", "at": "+1h" }
{ "command": "./report.sh", "at": "2026-11-05T09:00:00+08:00" }
// env
{ "command": "pytest -q", "env": { "PYTHONUNBUFFERED": "1", "TERM": "xterm" } }
// fail_on (adds to the built-ins) / fail_on: "" (disables them)
{ "command": "./deploy.sh", "fail_on": "QUOTA_EXCEEDED" }
{ "command": "./test-auth-errors.sh", "fail_on": "" }
// builtin_fail: false keeps a custom fail_on but drops the built-ins
{ "command": "./x.sh", "fail_on": "panic:", "builtin_fail": false }
// Jobs that relay other programs' output (watchers/monitors that copy other tabs,
// logs or terminals into their own output) should set builtin_fail: false — someone
// else's "Reauthentication failed" in the relayed text would otherwise kill the watcher.
{ "command": "~/.pi/manager-watch.sh --follow", "notify_on": "DONE", "builtin_fail": false }
// preflight
{ "command": "./rollout.sh", "preflight": "gcloud auth print-access-token >/dev/null" }
// ok_codes: exit 2 means "already merged", not an error
{ "command": "./merge-pr.sh 123", "ok_codes": [0, 2] }
```

### Yield

For commands that usually finish in seconds but might hang, set `yield_ms` instead of using plain `bash`:

```jsonc
{ "command": "npm test", "yield_ms": 10000 }
```

The job starts exactly like any other `bash_bg` job. If it exits within `yield_ms`, the tool result contains its exit code and the last 200 lines of output (40 KB cap), no exit message is sent later, and the job is listed as finished. If it is still running, the result has the job id, log path and the last 10 lines so far; the job keeps running and the usual messages (`notify`, `notify_on`, `idle_warn`) apply. `yield_ms` must be greater than 0 and at most 60000, and cannot be combined with `wait_until` or `at`. Plain `bash` is still fine for trivially short commands.

### `bash_bg_output` parameters

| Parameter | Default | Meaning                                                    |
| --------- | ------- | ---------------------------------------------------------- |
| `id`      |         | Job id; omit to list jobs                                  |
| `lines`   | `60`    | Number of trailing output lines                            |
| `all`     | `false` | List every remembered job, not just active and last-hour ones |

```jsonc
{ "id": "bg12", "lines": 100 }
{ "all": true }
```

### `bash_bg_kill` parameters

| Parameter | Meaning               |
| --------- | --------------------- |
| `id`      | Job id, or `"all"`    |

```jsonc
{ "id": "bg12" }
```

## Command

```
/bg              active jobs and jobs finished in the last hour
/bg all          every remembered job
/bg log <id>     last 60 lines of output
/bg kill <id>    stop or cancel one job, or /bg kill all
```

The footer shows the running job(s) with their age plus the number of scheduled jobs, refreshed every 15 seconds.

## Behavior

- **Notifications.** On exit the agent gets the exit code and the last 30 lines. If the agent is busy the message is queued as a follow-up.
- **`notify_on` batching and rate limit.** Matches are collected for 5 s and sent as one message with each matching line (`>`) plus 3 lines of context after it. Per job, messages are at least 30 s apart and at most 20 per hour; matches beyond that are counted and reported in the exit message. Matches not yet sent when the job exits are included in the exit message.
- **Environment.** Every job gets `NO_COLOR=1`, `TERM=dumb`, `CLOUDSDK_CORE_DISABLE_PROMPTS=1`, `CLOUDSDK_CORE_DISABLE_COLOR=1`, `PAGER=cat`, `GIT_PAGER=cat`, `GH_PAGER=cat` unless `env` overrides them.
- **Clean text.** ANSI escape sequences and carriage-return progress lines are removed from messages and `bash_bg_output`.
- **Built-in fail patterns.** gcloud `Reauthentication failed`, `There was a problem refreshing your current auth tokens`, `Please run: $ gcloud auth login`; gh `authentication required`, `HTTP 401: Bad credentials`. A match kills the job's process group and the exit message says which pattern matched.
- **Redaction.** Messages and `bash_bg_output` mask Slack `xox?-`, `sk-`/`sk-or-v1-`, GitHub `ghp_/gho_/ghs_/ghu_/ghr_/github_pat_`, Google `GOCSPX-`, `ya29.`, `AIza`, AWS `AKIA`, `Bearer` tokens and private-key blocks, keeping a short prefix plus `***`. Log files on disk are not redacted.
- **Storage.** State lives in `~/.pi/bg-bash/` (override with `PI_BG_BASH_DIR`): `jobs.json` (registry, mode 600) and `logs/<id>.log` plus `<id>.log.exit`. Finished jobs older than 24 h are dropped together with their logs. Job ids keep counting across reloads.
- **Lifetime.** Jobs run detached in their own process group. `/reload` leaves them running; the new extension instance re-attaches, keeps tailing, and sends the exit message once for jobs that ended during the reload. Scheduled jobs still start after a reload. Quitting pi, `/new`, `/resume` and `/fork` stop all jobs without a message.

## Install

```bash
pi install ./packages/pi-bg-bash
```
