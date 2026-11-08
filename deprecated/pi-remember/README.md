# @geminixiang/pi-remember

A skill that records durable decisions into `AGENTS.md`, where Pi already loads them every session.

Pi walks from the working directory up to the filesystem root collecting `AGENTS.md` or `CLAUDE.md`, plus one from the agent directory, and puts them in context on every run. That mechanism is already there and costs nothing. What was missing was a reason for the agent to write to it: appending to a Markdown file is not an obvious action, so it rarely happens unless asked.

Every skill's name and description sit in the system prompt on every turn, so a skill is enough to supply that reason. It says to record the moment a durable decision appears, without waiting to be asked.

## Install

```sh
npm i @geminixiang/pi-remember
```

Then invoke it with `/skill:remember`, or simply state a preference and let the agent record it.

## What it writes

Notes go inside a marked section so hand-written guidance and agent-written notes share one file without either clobbering the other:

```markdown
# AGENTS.md

Always run `npm run verify` before pushing.

<!-- pi-remember:start -->
## Notes

- 2026-08-02 Pin TypeScript 7.0.2 across packages; mixed versions made CI disagree with local runs
<!-- pi-remember:end -->
```

Everything outside the markers stays untouched. A fact already listed is not added twice. If the project has a `CLAUDE.md` instead, notes go there.

## Why a skill and not a tool

An earlier version shipped a `remember` tool that did the same writing in code, with the file handling guaranteed rather than performed by the agent. It was removed.

The code bought correct section handling, deduplication, and file selection. The failure it prevents is a duplicated or misplaced line in a Markdown file — something you fix by deleting it. Weighed against that, a package with no code at all is easier to read, install, and change, and the skill is edited in place when the guidance needs tuning.

Reach for a tool instead when a wrong write is expensive or must be auditable. `@geminixiang/pi-memory` takes that position to its conclusion: every note is a candidate until a human approves it, with provenance, expiry, and an append-only event log.
