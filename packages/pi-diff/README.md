# @geminixiang/pi-diff

[![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-diff)](https://www.npmjs.com/package/@geminixiang/pi-diff)
[![CI](https://github.com/geminixiang/pi-stuff/actions/workflows/ci.yml/badge.svg)](https://github.com/geminixiang/pi-stuff/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40geminixiang%2Fpi-diff)](LICENSE)

Pi extension that registers `/diff`, opening a browser dashboard using [diff2html](https://github.com/rtfpessoa/diff2html).

![pi-diff demo](https://raw.githubusercontent.com/geminixiang/pi-stuff/main/packages/pi-diff/assets/pi-diff-demo.png)

## Install

```bash
pi install npm:@geminixiang/pi-diff
```

For local development:

```bash
pi install ./path/to/pi-diff
```

## Use

```text
/diff
```

The page shows working tree diff, staged diff, and recent commit diffs. Optional args are passed to the working tree `git diff`, for example:

```text
/diff --cached
/diff HEAD~1
```

For an iterative agent review workflow, use:

```text
/diff
```

Review mode sorts changed files by modification time. Select code text (a floating **Comment lines X–Y** button appears), or click/drag line numbers, to add a GitHub-style review comment — `⌘⏎`/`Ctrl+Enter` adds it, `Esc` cancels, and saved comments can be edited or removed inline. A selection that spans deleted and added lines keeps both ranges: the comment is labeled **Old A–B · New X–Y**, both sides stay highlighted, and the agent receives both line ranges. Choose **Submit review** to send all comments to the current Pi agent; each comment includes a short code excerpt so the agent can locate it even after further edits. Submitted file versions leave the review queue; if the agent changes them again, they reappear automatically.

While the agent keeps working, the page updates in place instead of reloading: pending comments and open comment drafts survive diff refreshes, view-mode switches, and full page reloads. If a file changes under a pending comment, the comment is flagged as stale and annotated on submit rather than rejected.

The extension starts a local `127.0.0.1` server for the session and closes it on Pi shutdown/reload.

## Development checks

```bash
npm test
npm run perf
```

`npm run perf` creates a temporary Git repo and fails if watcher events are not coalesced or `.gitignore`d writes trigger Git checks.
