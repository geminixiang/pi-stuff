# @geminixiang/pi-hooks

Run commands automatically on Pi agent events, configured as data rather than code. One of those events, `tool_call`, is consulted _before_ the action happens, so a hook can deny it.

This is the difference between a tool and a hook: a tool is offered to the model and may or may not be called, while a hook always runs. Anything that must happen — formatting a file after it is written, refusing to push while verification is stale — belongs here.

## Configuration

Two files are read, both optional:

- User: `<agent dir>/hooks.json`, by default `~/.pi/agent/hooks.json`
- Project: `<cwd>/<CONFIG_DIR_NAME>/hooks.json`, by default `.pi/hooks.json`

```json
{
  "hooks": {
    "tool_call": [
      {
        "name": "verify-before-push",
        "match": "^(bash|git_push)$",
        "command": ["npm", "run", "verify"],
        "blockOnFailure": true,
        "timeoutMs": 120000
      }
    ],
    "tool_result": [{ "match": "^(write|edit)$", "command": ["npx", "oxfmt"] }],
    "session_start": [{ "command": ["git", "fetch", "--quiet"] }]
  }
}
```

Supported events: `session_start`, `session_shutdown`, `tool_call`, `tool_result`, `turn_end`.

| Field            | Meaning                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `command`        | Argument vector, required. Never a shell string.                                                                                                 |
| `match`          | Regular expression on the tool name. A hook without one runs for every tool; a hook with one never fires for an event that carries no tool name. |
| `blockOnFailure` | `tool_call` only. A non-zero exit denies the call and reports the hook's stderr to the agent.                                                    |
| `timeoutMs`      | Defaults to 30000. An overrunning hook is killed.                                                                                                |
| `name`           | Label used when reporting what a hook did.                                                                                                       |

`/hooks` lists what is loaded; `/hooks reload` re-reads the files after editing. The `hooks_list` tool exposes the same list to the agent, so it can tell why a call was denied.

## Why a hook cannot be a shell string

A hook fires with agent-controlled values in scope — the tool name, and the tool's input. Those reach the command through the environment (`PI_HOOK_TOOL`, `PI_HOOK_INPUT` as JSON, `PI_HOOK_CWD`, `PI_HOOK_SESSION`) and never through its argument vector, and no shell is invoked. A path chosen by the model cannot become a command that way.

## Trust

Project hooks run only when Pi marks the project trusted. A `hooks.json` is executable configuration, so opening an untrusted checkout must not be enough to run commands from it. User hooks are the operator's own and always apply.

A file that is unreadable, malformed, or contains an unusable regular expression disables _its own_ hooks and reports a warning; it never takes down the session. Validation failures name the offending location, such as `/hooks/tool_call/0/command must be array`.

## Failure handling

For observational events a failing hook is reported and otherwise ignored. For `tool_call`, only a hook that set `blockOnFailure` can deny; any other failure is reported and the call proceeds. A hook that cannot be spawned at all is treated as a failure rather than thrown, so a typo in a command never breaks a turn.
