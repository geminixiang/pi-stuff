# @geminixiang/pi-verification

Advisory verification for Pi, backed by `@geminixiang/pi-supervisor` taskd.

This extension cannot prevent Pi core from completing a run. On `agent_settled`, it may enqueue bounded repair follow-ups; errors are reported as **inconclusive**, not pass or fail. Repair attempts are persisted per Git/plan fingerprint.

## Runtime

By default, checks use the supervisor's public `TaskClient` protocol (`start`, `wait`, `output`, `get`, and `stop`). taskd must be running; install/load `@geminixiang/pi-supervisor` to auto-start it. `LocalTaskClient` is non-durable and is used only with explicit `createVerificationExtension({ allowNonDurableLocalFallback: true })` opt-in.

`verification_run` requires project trust. In an untrusted project it asks for confirmation when dialog UI exists, and refuses in non-UI modes. Project and check working directories are canonicalized, and check directories must remain inside the project root.

## Tools

- `verification_plan`: stores a normalized executable/arguments plan.
- `verification_run`: runs checks through taskd and stores evidence.
- `verification_status`: reports pass/fail/stale/inconclusive state.
- `/verify status | run | plan <json>` exposes the same workflow.

```json
{
  "checks": [{ "id": "check", "command": "npm", "args": ["run", "check"], "timeoutMs": 120000 }],
  "concurrency": 2,
  "repairBudget": 1
}
```

State is written with mode `0600` under `.pi/verification-local/v1/`. Add this to the project's `.gitignore`:

```gitignore
.pi/verification-local/
```

Evidence fingerprints Git `HEAD`, staged and unstaged binary diffs, the canonical plan, and untracked entries. Regular untracked files up to 16 MiB are content-hashed; larger files use size/mtime metadata. Symlinks are hashed as symlink metadata and link target without following them.

Evidence contains only bounded, secret-redacted stdout/stderr summaries. Complete logs remain in taskd and evidence stores only `{ taskId, stream }` locators.
