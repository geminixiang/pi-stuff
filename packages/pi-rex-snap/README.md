# @geminixiang/pi-rex-snap

Restarting the [Rex](https://www.superlogical.com/rex) server, which an update asks you to do, closes every session. This package saves your Rex sessions, windows, splits, the working directory of each pane, and **which pi session runs in each pane**. After the restart, one command reopens all of them and resumes each pi conversation with `pi --session <file>`.

## Install

```sh
pi install npm:@geminixiang/pi-rex-snap
```

For the `rex-snap` command outside pi:

```sh
npm install -g @geminixiang/pi-rex-snap
```

## Use

```sh
rex-snap save       # before updating Rex
# update Rex and restart the server
rex-snap restore    # reopens everything
```

| Command                               | What it does                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `rex-snap save`                       | Writes `~/.local/state/rex-snap/<time>.json` and points `latest.json` at it. Exits 2 if a pi pane has no session id. |
| `rex-snap show [FILE]`                | Prints a snapshot.                                                                                                   |
| `rex-snap restore [FILE] [--dry-run]` | Recreates sessions, windows and splits. `--dry-run` prints the `rex` commands without running them.                  |

Inside pi the same actions are available as `/rex-snap save`, `/rex-snap show` and `/rex-snap restore [--dry-run]`.

What restore puts in each pane:

- **pi**: runs `pi --session <file>` in the pane's directory.
- **pi with an unknown session**: types `pi -r` without pressing Enter, so you can pick the session.
- **Another program**: types its command line without pressing Enter, so you decide whether to run it.
- **A shell**: opens a shell in the saved directory.

If a session with the same label still exists, the restored one is named `<label>-restored`.

## How it knows the pi session

Rex can see that a pane runs `pi` but not which session file it has open. The extension in this package runs inside pi. Every time a session starts, reloads, or switches (`/new`, `/resume`, fork), it writes the session to `~/.local/state/rex-pi/<block>.json`, keyed by `REX_BLOCK`.

`rex-snap save` uses a record only when its pid matches the pane's current foreground process, so a record left by an earlier pi in the same pane is ignored. Records are never deleted on shutdown, because a Rex server restart kills pi too, and the record has to survive it.

pi processes started before you installed the package have no record yet. Run `/reload` in each of them, then save again. `rex-snap save` reports which panes are missing.

## Requirements

- Rex with the `rex` CLI on `PATH`
- Pi 1.x
- Node.js 22.19 or newer
