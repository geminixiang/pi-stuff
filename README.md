# pi-stuff

Monorepo for `@geminixiang` packages that extend the [Pi coding agent](https://github.com/badlogic/pi-mono).

## Install

Install the whole suite (every extension and skill below) with one command:

```sh
pi install git:github.com/geminixiang/pi-stuff
```

Run `pi config` to turn individual resources off. Each package can also be installed on its own, for example `pi install npm:@geminixiang/pi-simplify`. Remove the standalone entry when you switch to the suite, so tools are not registered twice.

Shared skills in [`skills/`](skills): `evidence-chain`, `upstream-pr`, `ui-evidence`, `pr`, `rigor-mode`, `taiwan-patent`.

## Packages

| Package                                                              | Version                                                                                                                                       | Description                                                                                                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@geminixiang/pi-simplify`](packages/pi-simplify)                   | [![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-simplify)](https://www.npmjs.com/package/@geminixiang/pi-simplify)                   | Review changed code for reuse, quality, and efficiency. It also includes the `/code-smell` workflow.                                        |
| [`@geminixiang/pi-agent-team`](packages/pi-agent-team)               | [![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-agent-team)](https://www.npmjs.com/package/@geminixiang/pi-agent-team)               | Rule-agnostic independent agent sessions with private mailboxes, handoff, claims, and causal audit.                                         |
| [`@geminixiang/pi-cicd-status`](packages/pi-cicd-status)             | [![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-cicd-status)](https://www.npmjs.com/package/@geminixiang/pi-cicd-status)             | Inspect CI/CD status through GitHub check runs and workflow runs.                                                                           |
| [`@geminixiang/pi-native-web-search`](packages/pi-native-web-search) | [![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-native-web-search)](https://www.npmjs.com/package/@geminixiang/pi-native-web-search) | Search the web through Pi's configured OpenAI Codex or Anthropic account.                                                                   |
| [`@geminixiang/pi-packyapi`](packages/pi-packyapi)                   | [![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-packyapi)](https://www.npmjs.com/package/@geminixiang/pi-packyapi)                   | Use a curated PackyAPI model catalog with secure Pi login.                                                                                  |
| [`@geminixiang/pi-diff`](packages/pi-diff)                           | [![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-diff)](https://www.npmjs.com/package/@geminixiang/pi-diff)                           | Open a GitHub-like Git diff viewer in the browser.                                                                                          |
| [`@geminixiang/pi-gpt-image`](packages/pi-gpt-image)                 | [![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-gpt-image)](https://www.npmjs.com/package/@geminixiang/pi-gpt-image)                 | Generate and edit images with gpt-image-2 through Pi's existing Codex OAuth login.                                                          |
| [`@geminixiang/pi-task-protocol`](packages/pi-task-protocol)         | 0.1.0                                                                                                                                         | Versioned contracts for durable local tasks, events, output cursors, and lifecycle transitions.                                             |
| [`@geminixiang/pi-supervisor`](packages/pi-supervisor)               | 0.1.0                                                                                                                                         | Run shell-free processes and services through a crash-reconciled local task daemon.                                                         |
| [`@geminixiang/pi-verification`](packages/pi-verification)           | 0.1.0                                                                                                                                         | Run project verification plans through the supervisor and retain fresh, redacted evidence.                                                  |
| [`@geminixiang/pi-jev`](packages/pi-jev)                             | 0.1.0                                                                                                                                         | Ask Jev, TypeSafe's calibrated decision model, typed boolean/choice/score questions for classification, scoring, ranking, and verification. |
| [`@geminixiang/pi-rex-snap`](packages/pi-rex-snap)                   | 0.1.0                                                                                                                                         | Save Rex sessions with the pi session in each pane, and restore them after a Rex server restart.                                            |
| [`@geminixiang/pi-tasks`](packages/pi-tasks)                         | 0.1.0 (private)                                                                                                                               | Project-level SQLite task list for a Pi session that delegates work to subagents.                                                           |

The new runtime packages form a layered suite:

```text
pi-supervisor ──> pi-task-protocol
pi-verification ──> pi-supervisor
```

`pi-supervisor` also exposes a process-local client for the public `pi-subagents` v2 event-bus RPC. It does not claim durable subagent identity because the upstream public interface currently exposes only ping, spawn, and stop.

The standalone `@geminixiang/pi-code-smell` package is intentionally not part of this repository. Its functionality remains available through `@geminixiang/pi-simplify`.

## Deprecated

[`deprecated/`](deprecated) holds packages that are no longer installed with the suite or released. See its README for the reasons and replacements.

## License

Unless otherwise noted, packages in this repository are licensed under the MIT License. `packages/pi-native-web-search` is derived from Armin Ronacher's `mitsuhiko/agent-stuff` and is licensed under the Apache License 2.0; see its package-level [`LICENSE`](packages/pi-native-web-search/LICENSE) and attribution.

## Development

Requires Node.js 22.19 or newer. Pi dependencies target **1.x** (peer range `>=1.0.0 <2.0.0`); development and verification use **1.0.4**.

```sh
npm install
npm run verify
npm run pack:check
```

Run a command for one package with npm's workspace flag:

```sh
npm test --workspace @geminixiang/pi-diff
npm run lint --workspace @geminixiang/pi-simplify
```

## Release skill

The repository includes a project-local [`release` skill](.pi/skills/release/SKILL.md). It prepares and publishes one workspace at a time using package-scoped release tags such as `pi-diff@0.4.1`, then verifies the trusted-publishing workflow and npm registry result.

## Publishing

Each workspace is versioned and published independently. Create a GitHub release whose tag has the form `<package>@<version>`, for example:

```text
pi-diff@0.4.1
```

The publish workflow verifies that the tag matches the selected workspace's `package.json` before publishing it to npm with provenance.
