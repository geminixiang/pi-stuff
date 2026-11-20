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
| T4 | The flaky HTTP service is started with `supervisor_start` and listens on a port. The one-off build runs under `bash_bg`, retries the 503s, and writes `build-ok` with at least one flake. After SIGKILL of the host process, taskd is still alive and the port still accepts HTTP. The `bash_bg` child may be dead or alive; that is recorded and is not a failure. |
| T5 | A fixed 1-minute loop reads `status.txt` on a fake clock. Fires before a sleep jump sit on the interval grid (`driftMs` 0, `missed` 0, `duplicates` 0). A single 10-minute tick fires the loop once, not once per missed minute. The tick after `READY` is written observes `READY`. |
| T6 | The loop runs a CI script that fails while `.bug` exists. The scripted turn removes `.bug` once and reruns to exit 0. Advancing five minutes while that turn is busy does not deliver another loop run. |
| T11 | The T1 gate, with no TTY and no `ctx.ui`. No uncaught exception and no `pi-tui` / `ui` exception. The bg-bash message renderer is invoked headlessly and must not throw. |
| T12 | Resume the same session after the fixed loop's next fire time has passed. The loop is restored with `runs=1` and does not fire on the immediate next timer tick. |

`bash` vs `bash_bg` vs `supervisor_start` is the wrong-tool metric. Fake-clock tasks load only `pi-loop`. The other tasks load `pi-bg-bash`, `pi-loop`, and `pi-supervisor`.

Out of scope here: T7–T10 (approval, unsafe commands, web-search degrade).

## Baseline on current main

Recorded against extension source `c41a4c0` (this PR does not modify extension code). Command: `npm run eval:extensions`. Deterministic repetitions = 1. T12 is the only `expectedFail`.

| Task | Status | Wall time | Notifications | Wrong tool | Tool errors | Crashes | UI exceptions | pass@1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| smoke rpc | pass | | | | | 0 | | |
| T1 | pass | 1.3s | 1 | 0 | 0 | 0 | 0 | 1 |
| T2 | pass | 2.3s | 1 | 0 | 0 | 0 | 0 | 1 |
| T3 | pass | 15.7s | 2 | 0 | 0 | 0 | 0 | 1 |
| T4 | pass | 1.1s | 0 | 0 | 0 | 0 | 0 | 1 |
| T5 | pass | 0.0s | 6 | 0 | 0 | 0 | 0 | 1 |
| T6 | pass | 0.0s | 1 | 0 | 0 | 0 | 0 | 1 |
| T11 | pass | 1.1s | 1 | 0 | 0 | 0 | 0 | 1 |
| T12 | expected-fail | 0.0s | 2 | 0 | 0 | 0 | 0 | 0 |

T5 grid on the steady ticks: `driftMs` 0, `missed` 0, `duplicates` 0. The 10-minute jump fired the loop once (`sleepFires` 1). The following tick saw `READY`.

T12 restores the loop (`runs=1`) and then fires on the next 1ms tick because `nextAt` was overdue. That immediate catch-up is the expected failure. There is no steady-grid drift and no sleep-jump burst on current main.

T4 after SIGKILL of the host: `taskdAlive` true, `portListening` true, `buildAlive` true. The build process survived because `bash_bg` detaches it into its own process group. That survival is not the contract. taskd and the listening service must survive a hard kill. A plain `bash_bg` child is not supervised and may die; a run where it is dead still passes.

Live mode was not run. This environment has no provider API key. Fake-clock tasks (T5, T6, T12) are skipped in live mode even when a key is present, because the grid is not meaningful on a real clock. `node evals/extensions/run.mjs --mode live` skips every task and exits 0 when no key is set.

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

**deterministic** (CI). A fake `ExtensionAPI` in the same style as `packages/pi-bg-bash/test/bg.test.mts` and `packages/pi-loop/test/schedule.test.mts`: `on` keeps a list of handlers, tools and commands are registered, `sendMessage` / `ui.notify` are recorded. `drive.mjs` is the scripted agent. `clock: "real"` is used when the task spawns processes. `clock: "fake"` installs `node:test` mock timers (`harness/clock.mjs`) and is what T5, T6, and T12 use. A delivered loop message marks the agent busy until `endTurn`, so a clock jump cannot re-enter mid-turn. A built-in `bash` stand-in exists so a drive that blocks in `bash` is visible to the wrong-tool metric.

`task.extensions` limits which product extensions load. Omit it to load `pi-bg-bash`, `pi-loop`, and `pi-supervisor`. Fake-clock tasks load only `pi-loop` so a mocked timer does not stall taskd.

Loop grid metrics (`trace.loopGrid`, also on the summary) come from `scoreLoopGrid`: `driftMs` is the worst distance from a fire to the interval grid anchored on the first fire, `missed` is a grid slot with no fire, and `duplicates` is an extra fire in a slot that already fired. T5 also records `sleepFires`, how many times the loop fired inside one multi-interval tick.

**live**. A small JSONL client (`harness/rpc.mjs`) speaks pi's public RPC: `prompt`, `steer`, `get_state`, `abort`, and `extension_ui_response`. Records are split on LF only. It is not copied from another project. Stdin and stdout are pipes, so there is no TTY.

Dialog extension-UI requests are auto-confirmed so a run can finish. That is not an approval score; approval tasks are a later PR. Every dialog is stored on the trace as `uiRequests`.

Live mode skips tasks with `clock: "fake"` and lists them on `skippedTasks`. A real clock cannot score the grid.

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

`ctx` carries `workspace`, `paths`, `mode`, `headless`, `trace`, `taskPolicy`, and, in deterministic mode, `callTool`, `reload`, `resume`, `suspend`, `boot`, `endTurn`, `waitFor`, and `clock`. `suspend` plus `boot` is how T12 resumes one session after fake time has passed.

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

Each run has `status` (`pass`, `fail`, `expected-fail`, `unexpected-pass`), `success`, `failures`, `crashes`, `uiExceptions`, `toolErrors`, `wrongTool`, `wrongToolCalls`, `notificationCount`, `wallTimeMs`, `tokens` (live only), and `loopGrid` (fake-clock loop tasks). `passAt` is grouped by task. With `n` repetitions and `c` successes, pass@k is `1 - C(n-c, k) / C(n, k)` for `k = 1..n` (the chance that k samples include at least one success). `expected-fail` is not counted as a success.

The stdout table is the same summary, one task per line.
