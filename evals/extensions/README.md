# Extension evals

Real-task checks for `pi-bg-bash`, `pi-loop`, `pi-native-web-search`, and their interplay with `pi-supervisor`. This directory is not an npm workspace and is not published. It does not change extension behavior.

The shape follows `packages/pi-agent-team/docs/lifecycle-improvement-evaluation.md`: freeze the success criteria first, record a baseline, and keep live model runs off the PR gate.

## Frozen success criteria

These are the gates for the tasks in this PR. Later product changes are accepted only when the same checks still pass. Do not weaken a check to make a product change green. A known failure on the recorded baseline is an `expectedFail` entry with a reason, not a skipped assertion.

| Task | Gate |
| --- | --- |
| T1 | Start `node server.mjs` and run `node test.mjs` without blocking. `bash_bg` is used for both, `supervisor_start` is not, and a blocking `bash` sleep/poll of either script counts as a wrong tool. The server tool returns while the process is still running. The test job posts one exit notification with `ok: true`, and `test-result` is `ok`. |
| T2 | Start the delayed server with `bash_bg`. Waiting is `wait_until` or `notify_on`, not a `bash` sleep/poll loop and not `supervisor_start`. The wait tool returns while its job is still running, then an exit notification reports success. `ready` exists and is non-empty. |
| T3 | A log-writing `bash_bg` job is still alive after reload (`session_shutdown` reason `reload`, or pi's `session.reload()`). That job is notified exactly once when it exits. The next background id is higher than the survivor's id. `job.log` contains `tick-` lines. |
| T11 | The T1 gate, with no TTY and no `ctx.ui`. No uncaught exception and no `pi-tui` / `ui` exception. The bg-bash message renderer is invoked headlessly and must not throw. |

`bash` vs `bash_bg` vs `supervisor_start` is the wrong-tool metric. `pi-loop` and the `native-web-search` skill are loaded in every run so later tasks can use them; T1–T3 and T11 do not require loop or web search.

Out of scope here: T4–T6 and T12 (next PR, including fake-clock grids) and T7–T10 (approval, unsafe commands, web-search degrade).

## Baseline on current main

Recorded against extension source `dfb25f92c99d8bbb3ff762c5e93879ceca4ad556` (this PR does not modify extension code). Command: `npm run eval:extensions`. Deterministic repetitions = 1, so pass@1 is the run result. No task is marked `expectedFail`. T11 was the headless candidate and it passed, so a later headless regression fails CI.

| Task | Status | Wall time | Notifications | Wrong tool | Tool errors | Crashes | UI exceptions | pass@1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| smoke rpc | pass | | | | | 0 | | |
| T1 | pass | 1.29s | 1 | 0 | 0 | 0 | 0 | 1 |
| T2 | pass | 2.30s | 1 | 0 | 0 | 0 | 0 | 1 |
| T3 | pass | 15.68s | 2 | 0 | 0 | 0 | 0 | 1 |
| T11 | pass | 1.12s | 1 | 0 | 0 | 0 | 0 | 1 |

T3's second notification is the follow-up `true` job used to prove ids keep counting (`bg1` survives, the next id is `bg2`).

Live mode was not run. This environment has no provider API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, and the other names in `harness/extensions.mjs`). `node evals/extensions/run.mjs --mode live` skipped the tasks and exited 0. The RPC load smoke above did run: it starts `pi --mode rpc` with the unpublished extensions and no model.

## Run

From the repository root, after `npm install`:

```sh
npm run eval:extensions
node evals/extensions/run.mjs --mode deterministic --task T1,T11
npm run eval:extensions:live -- --model anthropic/claude-sonnet-4-5 --repetitions 3
node evals/extensions/run.mjs --mode live --task T1 --repetitions 1 --model openai/gpt-5.4
```

`npm run verify` runs the deterministic suite (unit tests, RPC smoke, T1, T2, T3, T11). That is the PR CI gate. It does not call a model.

Live mode is manual. `.github/workflows/extension-evals-live.yml` is `workflow_dispatch` only. It exits 0 without a key. With a key it runs every task `--repetitions` times (default 3) and reports pass@k. A real live failure exits non-zero so the dispatched run is red; it does not gate pull requests.

Tokens are summed from assistant `message_update` / `message_end` usage. Deterministic runs record `tokens: null`.

## Sandbox

Each task gets a `mkdtemp` directory. The process `HOME` is pinned to a suite temp directory, and the task sets:

- `PI_CODING_AGENT_DIR`
- `PI_BG_BASH_DIR`
- `PI_TASKD_HOME`

The runner refuses paths inside the real `~/.pi` or outside the system temp dir. Task cleanup signals recorded background process groups and the taskd pid in `taskd.sock.lock`.

## Loading unpublished extensions

Pi in this repo is 1.0.4 (`@earendil-works/pi-coding-agent`). Two ways to load a package that is not on npm:

**This process only**, which is what the runner uses:

```sh
pi --no-extensions --no-skills \
  --extension "$REPO/packages/pi-bg-bash/extensions/index.ts" \
  --extension "$REPO/packages/pi-loop/extensions/index.ts" \
  --extension "$REPO/packages/pi-supervisor/extensions/pi-supervisor.ts" \
  --skill "$REPO/packages/pi-native-web-search/skills"
```

`--no-extensions` and `--no-skills` turn off discovery. Explicit `--extension` and `--skill` still load. Paths are files or directories. Repeat the flags. `PI_CODING_AGENT_DIR` must point at the sandbox (`getAgentDir()` reads that variable before `~/.pi/agent`).

**Install into an isolated agent dir** (does not copy the package; it records the source path):

```sh
PI_CODING_AGENT_DIR="$SANDBOX/agent" pi install "$REPO/packages/pi-bg-bash"
```

That writes `$SANDBOX/agent/settings.json` with a `packages` entry. A later `pi` with the same `PI_CODING_AGENT_DIR` loads it. Do not run `pi install` without that variable: the default target is `~/.pi/agent`.

## Modes

**deterministic** (CI). A fake `ExtensionAPI` in the same style as `packages/pi-bg-bash/test/bg.test.mts` and `packages/pi-loop/test/schedule.test.mts`: `on` keeps a list of handlers, tools and commands are registered, `sendMessage` / `ui.notify` are recorded. `drive.mjs` is the scripted agent. `clock: "real"` is required for these tasks because they spawn processes. `clock: "fake"` installs `node:test` mock timers (`harness/clock.mjs`) for a later grid; the harness unit test advances a 60s timer without waiting. A built-in `bash` stand-in exists so a drive that blocks in `bash` is visible to the wrong-tool metric.

**live**. A small JSONL client (`harness/rpc.mjs`) speaks pi's public RPC: `prompt`, `steer`, `get_state`, `abort`, and `extension_ui_response`. Records are split on LF only. It is not copied from another project. Stdin and stdout are pipes, so there is no TTY.

Dialog extension-UI requests are auto-confirmed so a run can finish. That is not an approval score; approval tasks are a later PR. Every dialog is stored on the trace as `uiRequests`.

### Reload

Interactive `/reload` is not an RPC command. It calls `AgentSession.reload()`, which emits `session_shutdown` with `reason: "reload"`. Deterministic T3 emits that event, then boots a new extension instance on the same session id and state dir. Live T3 sends `/eval-reload` after the first settled turn. That command lives only in `harness/reload-command.mjs` and calls `ctx.reload()`, which RPC binds to the same `session.reload()`. The smoke test checks that this prompt is `handled` without a model.

## Task directory

```text
evals/extensions/tasks/T1-background-server/
  task.json    id, title, headless, clock, timeoutMs, toolPolicy, live, expectedFail
  setup.mjs    export async function setup(ctx)
  prompt.md    user prompt for live mode
  drive.mjs    export async function drive(ctx)   # deterministic policy
  check.mjs    export async function check(ctx) -> { ok, failures }
  cleanup.mjs  export async function cleanup(ctx)
```

`ctx` carries `workspace`, `paths`, `mode`, `headless`, `trace`, `taskPolicy`, and, in deterministic mode, `callTool`, `reload`, `waitFor`, and `clock`.

`task.json` fields:

- `toolPolicy.requireTools`, `forbidTools`, `bashWrongIfMatches` (applied only to the `bash` tool), `requireAnyArg` (`{ tool, keys }`).
- `live.reloadWhileRunning` makes the live runner reload after the first settled turn, while the job should still be running.
- `live.followUp` is a second prompt after the exit notification (T3 uses it to allocate the next id).
- `expectedFail.deterministic` or `expectedFail.live` is a string reason. A failing run is then `expected-fail` and does not fail CI. A pass while that reason is set is `unexpected-pass` (still exit 0; delete the reason once you mean to keep the gate).

Add a task by creating the next `T*` directory and a `task.json` whose `id` matches. `npm run eval:extensions` picks up every directory under `tasks/` whose name starts with `T`.

## Results

Written under `evals/extensions/results/` (gitignored):

- `latest-deterministic.json` and `latest-live.json`
- `<timestamp>-<mode>/summary.json`

Each run has `status` (`pass`, `fail`, `expected-fail`, `unexpected-pass`), `success`, `failures`, `crashes`, `uiExceptions`, `toolErrors`, `wrongTool`, `wrongToolCalls`, `notificationCount`, `wallTimeMs`, and `tokens` (live only). `passAt` is grouped by task. With `n` repetitions and `c` successes, pass@k is `1 - C(n-c, k) / C(n, k)` for `k = 1..n` (the chance that k samples include at least one success). `expected-fail` is not counted as a success.

The stdout table is the same summary, one task per line.
