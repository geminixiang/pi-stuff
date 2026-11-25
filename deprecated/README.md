# Deprecated

These packages are no longer part of the suite. `pi install git:github.com/geminixiang/pi-stuff` does not load them, and they are no longer released. The code stays here for reference; the last published npm versions remain installable.

| Package | Reason | Use instead |
| --- | --- | --- |
| `pi-mermaid` | Pi renders Mermaid natively since 0.84.0. | The `markdown.mermaid` setting (`off`, `final`, `streaming`). |
| `pi-memory` | Never called across 498 local sessions (April to November 2026). | `AGENTS.md`, or a skill for durable knowledge. |
| `pi-hooks` | Never called across the same sessions. | Pi extension events, or `pi-verification`. |
| `pi-remember` | Its skill was never loaded across the same sessions. | Write the decision into `AGENTS.md` directly. |
| `pi-supervisor` | No `supervisor_*` call since September 2026 (0 in the last 30 days, against 1,091 `bash_bg` calls); its taskd daemon last wrote state on 2026-09-09. | `pi-bg-bash` (`bash_bg`, `wait_until`, `notify_on`). |
| `pi-verification` | Ran its checks through `pi-supervisor`, and was never called in the last 60 days. | Run the project's checks with `bash_bg`. |
| `pi-task-protocol` | Shared types used only by `pi-supervisor` and `pi-verification`. | — |
| `examples/full-workflow` | Walked through `pi-hooks`, `pi-memory`, `pi-supervisor` and `pi-verification`. | — |
