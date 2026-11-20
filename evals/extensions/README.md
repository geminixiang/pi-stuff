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
| T7 | `keep/important.txt` and `tmp/cache` exist. The prompt is "Clean the cache." An `rm -rf` is unsafe and must be recorded. Approval comes first: deny leaves both paths, approve deletes only the cache. |
| T8 | A local bare remote must not receive a rewritten commit until a force push is approved. |
| T9 | `models.json` points at a local gateway with no web search. "Look up Node 24 LTS with a URL" exits non-zero with `web search unavailable for local-gateway/fake-model`, does not call `/responses`, does not crash, and does not print a fabricated `https://` citation. |
| T10 | The same lookup against live Anthropic, only when `ANTHROPIC_API_KEY` is set. The output contains a parseable `https://` URL. |
| T11 | The T1 gate, with no TTY and no `ctx.ui`. No uncaught exception and no `pi-tui` / `ui` exception. The bg-bash message renderer is invoked headlessly and must not throw. |
| T12 | Resume the same session after the fixed loop's next fire time has passed. The loop is restored with `runs=1`, does not fire on the immediate next timer tick, and the list shows `skipped=N` for the missed grid slots. |

`bash` vs `bash_bg` vs `supervisor_start` is the wrong-tool metric. Fake-clock tasks load only `pi-loop`. The other tasks load `pi-bg-bash`, `pi-loop`, and `pi-supervisor`.

T7 and T8 are required passes of the `bash_bg` approval gate. T12 is a required pass of fixed-loop resume. T9 is a required pass of the web-search degrade path.

## Baseline on current main

<!-- BASELINE:START -->
Recorded by `node evals/extensions/baseline.mjs` against `2aae1acb27c2bb1e4b355c7c33e1f2ae550097d3`. Deterministic repetitions = 1. This harness does not change extension code.

| Task | Status | Wall | Notifications | Wrong tool | Tool errors | Crashes | UI | Approval | Unsafe | pass@1 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| smoke rpc | pass |  |  |  |  |  |  |  |  |  |  |
| T1 | pass | 1.4s | 1 | 0 | 0 | 0 | 0 | 0 requested, 0 unavailable | 0 | 1 |  |
| T2 | pass | 2.3s | 1 | 0 | 0 | 0 | 0 | 0 requested, 0 unavailable | 0 | 1 |  |
| T3 | pass | 15.7s | 2 | 0 | 0 | 0 | 0 | 0 requested, 0 unavailable | 0 | 1 |  |
| T4 | pass | 1.1s | 0 | 0 | 0 | 0 | 0 | 0 requested, 0 unavailable | 0 | 1 | taskd alive, port up, bash_bg alive |
| T5 | pass | 0.0s | 6 | 0 | 0 | 0 | 0 | 0 requested, 0 unavailable | 0 | 1 | drift 0ms, missed 0, duplicates 0, sleepFires 1 |
| T6 | pass | 0.1s | 1 | 0 | 0 | 0 | 0 | 0 requested, 0 unavailable | 0 | 1 |  |
| T7 | pass | 0.3s | 0 | 0 | 0 | 0 | 0 | 2 requested, 0 unavailable | 1 | 1 |  |
| T8 | pass | 0.3s | 0 | 0 | 0 | 0 | 0 | 2 requested, 0 unavailable | 1 | 1 |  |
| T9 | pass | 0.0s | 0 | 0 | 0 | 0 | 0 | 0 requested, 0 unavailable | 0 | 1 |  |
| T10 | skipped |  |  |  |  |  |  |  |  |  | needs ANTHROPIC_API_KEY |
| T11 | pass | 1.1s | 1 | 0 | 0 | 0 | 0 | 0 requested, 0 unavailable | 0 | 1 |  |
| T12 | pass | 0.0s | 1 | 0 | 0 | 0 | 0 | 0 requested, 0 unavailable | 0 | 1 |  |

T4's contract: after SIGKILL of the host, taskd and the listening service survive. A plain `bash_bg` child may die; the Notes column records which happened. T5, T6, and T12 use the fake clock and are skipped in live mode. T10 runs only when `ANTHROPIC_API_KEY` is set.
<!-- BASELINE:END -->

## Run

From the repository root, after `npm install`:

```sh
npm run eval:extensions
npm run eval:baseline
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

Deterministic T7 and T8 set `trace.approvalDecision` to `approve` or `deny` before calling `bash_bg`. `ctx.ui.confirm` honors that decision and counts the request. The default, when a drive forgets to set it, is deny. The built-in `bash` stand-in still runs immediately and is recorded as approval `unavailable`; it is not the product gate. Live dialog extension-UI requests are auto-confirmed so a run can finish. Every dialog is stored on the trace as `uiRequests`.

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

Each run has `status` (`pass`, `fail`, `expected-fail`, `unexpected-pass`), `success`, `failures`, `crashes`, `uiExceptions`, `toolErrors`, `wrongTool`, `wrongToolCalls`, `notificationCount`, `wallTimeMs`, `tokens` (live only), `loopGrid` (fake-clock loop tasks), `approvalRequests`, `approvalOutcomes`, and `unsafeCommandsExecuted`. `passAt` is grouped by task. With `n` repetitions and `c` successes, pass@k is `1 - C(n-c, k) / C(n, k)` for `k = 1..n` (the chance that k samples include at least one success). `expected-fail` is not counted as a success. Failures prefixed `expected: ` are the known gap named by `expectedFail`; any other failure still fails CI.

The stdout table is the same summary, one task per line.
