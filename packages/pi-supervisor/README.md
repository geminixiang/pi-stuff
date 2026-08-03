# @geminixiang/pi-supervisor

A local Unix-socket task daemon and Pi extension for crash-reconciled process/service supervision.

## CLI

```sh
taskd start
taskd run --cwd /absolute/path node server.js
taskd status [TASK_ID]
taskd stop TASK_ID
taskd shutdown
```

`taskd shutdown` stops the daemon itself, reading its pid from the socket lock and signalling it only while a live socket confirms the pid still belongs to taskd. Because taskd is shared by every Pi session on the machine, this also stops their background processes.

`taskd` never invokes a shell and does not accept task-specific environment values, preventing secrets from entering the durable task record. It validates an absolute working directory, records an atomic JSON snapshot and append-only JSONL event spool, writes stdout/stderr to separate permission-restricted files, supports positional bounded output reads and bounded waits, and stops detached process groups with TERM then KILL. After daemon restart it signals a recorded process group only when its stored process identity can be revalidated; otherwise the task becomes `orphaned` without signaling a potentially reused PID.

Set `PI_TASKD_HOME` or `PI_TASKD_SOCKET` to override paths. Pi loads `extensions/pi-supervisor.ts`, auto-starts/reconnects to taskd on `session_start`, and exposes `supervisor_start`, `supervisor_list`, `supervisor_logs`, and `supervisor_control`.

A daemon running an incompatible protocol rejects the request during schema validation and answers `ok: false`, so it never reports its own pid; the extension identifies it from the socket lock instead. It then reports the mismatch with the pid and how to stop it, rather than terminating a daemon that other Pi sessions may be relying on.

`list` and `get` report the TCP ports a task is listening on. Ports are observed live rather than stored, since what a process listens on changes independently of its durable record, and the whole process group is inspected because the port is usually held by a descendant — a wrapper script that sources an env file and then starts a server. The status bar shows running processes with their ports (`2 running: mikan :3000, api :8080`), refreshed every few seconds so a port bound after startup still appears.

`supervisor_start` returns immediately. Readiness and exit events are delivered asynchronously, so the agent should continue working instead of waiting or polling. Pass `name` to label a process; events and listings identify processes by that label, which matters once several run at once. Every process is owned by the Pi session that created it. Quitting, replacing, resuming away from, or forking away from that session stops all of its processes; `/reload` preserves them and reconnects by session ID.

`supervisor_logs` defaults to reading both streams from wherever the previous read stopped, so it can be called repeatedly against a running service with no offset bookkeeping. The first read of a stream, and `mode: "tail"`, read the end of the log instead of its beginning; `mode: "all"` reads from `offset`. `filter` keeps only lines matching a regular expression, applied in the extension rather than the shared daemon. A resumed read never returns more than `limit` bytes per stream and reports how many earlier bytes it skipped to stay within it.

A task becomes terminal only after its buffered output has reached disk, so logs read on an exit notification already include the process's final lines.

Each stream is a chain of rotating 8 MiB segments, so a long-lived service keeps logging instead of hitting a cap and going silent. Offsets are _logical_ — a count of bytes ever written, which only grows — while on disk a segment is named for the logical offset it starts at, so its range is recoverable from its name alone and survives a daemon restart with nothing persisted. One archived segment is retained per stream, giving an 8–16 MiB window; a read below `retainedFrom` starts at the earliest retained byte and reports the bytes it skipped rather than silently returning the wrong ones.

`SubagentRpcClient` is a process-local RPC client using only pi-subagents' public v2 event-bus `ping`, `spawn`, and `stop` contracts. It is not a durable adapter: requests, replies, and state are lost with the hosting Pi process. Upstream exposes no public lifecycle/status/output API; these are explicitly reported as unsupported capabilities.
