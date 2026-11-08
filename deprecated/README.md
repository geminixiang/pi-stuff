# Deprecated

These packages are no longer part of the suite. `pi install git:github.com/geminixiang/pi-stuff` does not load them, and they are no longer released. The code stays here for reference; the last published npm versions remain installable.

| Package | Reason | Use instead |
| --- | --- | --- |
| `pi-mermaid` | Pi renders Mermaid natively since 0.84.0. | The `markdown.mermaid` setting (`off`, `final`, `streaming`). |
| `pi-memory` | Never called across 498 local sessions (April to November 2026). | `AGENTS.md`, or a skill for durable knowledge. |
| `pi-hooks` | Never called across the same sessions. | Pi extension events, or `pi-verification`. |
| `pi-remember` | Its skill was never loaded across the same sessions. | Write the decision into `AGENTS.md` directly. |
| `examples/full-workflow` | Walked through `pi-hooks` and `pi-memory`. | The READMEs of `pi-supervisor` and `pi-verification`. |
