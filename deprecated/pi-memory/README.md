# pi-memory

Auditable provenance memory for Pi. It complements rather than replaces the context files Pi already loads.

Pi reads `AGENTS.md` or `CLAUDE.md` from the agent directory and the project, and puts them in context whole, every run. That suits standing instructions someone edits by hand. This package covers what a file cannot: a fact the agent noticed, which carries where it came from, needs a human to approve before it counts, expires, and can be superseded — with every transition recorded. Retrieval is selective rather than wholesale, so a large store does not crowd out the conversation.

## Storage

Memory is an append-only JSONL event log. Both scopes store `memory/v1/events.jsonl`; only the directory holding them differs:

- Project: `<cwd>/<CONFIG_DIR_NAME>/memory/v1/events.jsonl`, by default `.pi/memory/v1/events.jsonl`
- User: `<agent dir>/memory/v1/events.jsonl`, by default `~/.pi/agent/memory/v1/events.jsonl`

Neither path is assumed. The config directory name comes from the host's `CONFIG_DIR_NAME`, which is configurable through `piConfig.configDir`, and the agent directory from `getAgentDir()`, which honours `PI_CODING_AGENT_DIR`. Relocating either moves memory with it.

Project memory is generated state, so add it to the project's `.gitignore`:

```gitignore
.pi/memory/
```

Storage directories are mode `0700`; symlinked path components are rejected. Final files are opened through an `O_NOFOLLOW` handle and validated before reading. These checks are best-effort TOCTOU mitigation, not a security boundary against an attacker who can concurrently mutate parent directories.

Each scope uses a cross-process atomic lock file around load/validate/append transactions. Lock acquisition times out after 5 seconds; locks older than 30 seconds are treated as stale and removed. A truncated final JSONL line is ignored to recover from interrupted writes, while malformed complete events, forged statuses, version gaps, and illegal transitions are treated as corruption.

## Lifecycle

Agents can only create `candidate` records with `memory_propose`. Activation and destructive transitions require interactive confirmation through `memory_manage`:

`candidate -> active | rejected`, `active -> superseded | deleted`

Every record carries provenance, confidence, optional expiry, and tags. Confirmation first displays bounded record text, scope, provenance, confidence, expiry, status, and version; superseding displays both records. The transaction then revalidates the confirmed version and status before appending.

When pi marks a project untrusted, project memory is neither read nor injected, and project candidates cannot be proposed or approved. User-scope memory remains available. Before each agent run, at most five lexically relevant, active, unexpired records are injected, capped at 2,000 characters and identified by ID and provenance.

## Interface

Tools:

- `memory_propose`
- `memory_search`
- `memory_manage`

Commands:

- `/memory search <query>`
- `/memory candidates`

The secret scanner is best-effort and rejects common credentials without echoing submitted content in errors. It is not a substitute for secret-management controls.
