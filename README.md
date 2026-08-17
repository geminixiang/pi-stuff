# pi-stuff

Monorepo for `@geminixiang` packages that extend the [Pi coding agent](https://github.com/badlogic/pi-mono).

## Packages

| Package                                                      | Version                                                                                                                           | Description                                                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [`@geminixiang/pi-simplify`](packages/pi-simplify)           | [![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-simplify)](https://www.npmjs.com/package/@geminixiang/pi-simplify)       | Review changed code for reuse, quality, and efficiency. It also includes the `/code-smell` workflow. |
| [`@geminixiang/pi-agent-team`](packages/pi-agent-team)       | [![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-agent-team)](https://www.npmjs.com/package/@geminixiang/pi-agent-team)   | Rule-agnostic independent agent sessions with private mailboxes, handoff, claims, and causal audit.  |
| [`@geminixiang/pi-cicd-status`](packages/pi-cicd-status)     | [![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-cicd-status)](https://www.npmjs.com/package/@geminixiang/pi-cicd-status) | Inspect CI/CD status through GitHub check runs and workflow runs.                                    |
| [`@geminixiang/pi-diff`](packages/pi-diff)                   | [![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-diff)](https://www.npmjs.com/package/@geminixiang/pi-diff)               | Open a GitHub-like Git diff viewer in the browser.                                                   |
| [`@geminixiang/pi-mermaid`](packages/pi-mermaid)             | [![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-mermaid)](https://www.npmjs.com/package/@geminixiang/pi-mermaid)         | Render Mermaid diagrams as Unicode art inside the Pi terminal UI.                                    |
| [`@geminixiang/pi-gpt-image`](packages/pi-gpt-image)         | [![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-gpt-image)](https://www.npmjs.com/package/@geminixiang/pi-gpt-image)     | Generate and edit images with gpt-image-2 through Pi's existing Codex OAuth login.                   |
| [`@geminixiang/pi-task-protocol`](packages/pi-task-protocol) | 0.1.0                                                                                                                             | Versioned contracts for durable local tasks, events, output cursors, and lifecycle transitions.      |
| [`@geminixiang/pi-supervisor`](packages/pi-supervisor)       | 0.1.0                                                                                                                             | Run shell-free processes and services through a crash-reconciled local task daemon.                  |
| [`@geminixiang/pi-verification`](packages/pi-verification)   | 0.1.0                                                                                                                             | Run project verification plans through the supervisor and retain fresh, redacted evidence.           |
| [`@geminixiang/pi-memory`](packages/pi-memory)               | 0.1.0                                                                                                                             | Store reviewed cross-session memory with provenance and an auditable lifecycle.                      |
| [`@geminixiang/pi-hooks`](packages/pi-hooks)                 | 0.1.0                                                                                                                             | Run project or user commands automatically on agent events, including denying a tool call.           |
| [`@geminixiang/pi-remember`](packages/pi-remember)           | 0.1.0                                                                                                                             | Skill that records durable decisions into `AGENTS.md`.                                               |

[`examples/full-workflow`](examples/full-workflow) walks one scenario through every runtime package — bring up a dev server, get stopped from pushing something unverified, fix it, and leave a reviewed decision behind. Its configuration files are checked against the parsers they target.

The new runtime packages form a layered suite:

```text
pi-supervisor ──> pi-task-protocol
pi-verification ──> pi-supervisor
pi-memory and pi-hooks remain independent extensions
```

`pi-supervisor` also exposes a process-local client for the public `pi-subagents` v2 event-bus RPC. It does not claim durable subagent identity because the upstream public interface currently exposes only ping, spawn, and stop.

The standalone `@geminixiang/pi-code-smell` package is intentionally not part of this repository. Its functionality remains available through `@geminixiang/pi-simplify`.

## Development

Requires Node.js 22.19 or newer.

```sh
npm install
npm run verify
npm run pack:check
```

Run a command for one package with npm's workspace flag:

```sh
npm test --workspace @geminixiang/pi-mermaid
npm run lint --workspace @geminixiang/pi-simplify
```

## Release skill

The repository includes a project-local [`release` skill](.pi/skills/release/SKILL.md). It prepares and publishes one workspace at a time using package-scoped release tags such as `pi-mermaid@0.1.2`, then verifies the trusted-publishing workflow and npm registry result.

## Publishing

Each workspace is versioned and published independently. Create a GitHub release whose tag has the form `<package>@<version>`, for example:

```text
pi-mermaid@0.1.2
```

The publish workflow verifies that the tag matches the selected workspace's `package.json` before publishing it to npm with provenance.
