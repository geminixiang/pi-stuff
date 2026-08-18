# @geminixiang/pi-native-web-search

A [Pi coding agent](https://github.com/badlogic/pi-mono) skill for quick native web research using the provider and model active in the current Pi session.

## Install

```sh
pi install npm:@geminixiang/pi-native-web-search
```

For local development from this repository:

```sh
pi install ./packages/pi-native-web-search
```

Then ask Pi to research a current topic. The `native-web-search` skill runs automatically when appropriate.

## Direct usage

```sh
node skills/native-web-search/search.mjs "latest Python release" \
  --purpose "update dependency notes"
```

Options:

- `--provider <provider-id>` to intentionally override the current Pi session
- `--model <model-id>`
- `--timeout <milliseconds>`
- `--json`

The script reads Pi credentials from `${PI_CODING_AGENT_DIR:-~/.pi/agent}/auth.json` and provider defaults from `settings.json`. OAuth credentials can be refreshed and written back to `auth.json`.

When Pi exposes the active session through `PI_PROVIDER` and `PI_MODEL`, the script uses that provider and model by default. Built-in `openai-codex` and `anthropic` providers use their native web-search transports. Other active providers are resolved by their actual ID in `models.json` and use an OpenAI Responses-compatible `/responses` endpoint, preserving the provider's configured routing and credentials. Pass `--provider` only when you intentionally want to override the current session.

It uses Pi's bundled `@earendil-works/pi-ai`. Legacy `@mariozechner/pi-ai` installations remain supported. If module discovery fails, point `PI_AI_MODULE_PATH` and `PI_AI_OAUTH_MODULE_PATH` to pi-ai's `dist/index.js` and `dist/oauth.js` respectively.

## Attribution and license

This package is derived from the [`native-web-search` skill](https://github.com/mitsuhiko/agent-stuff/tree/main/skills/native-web-search) by **Armin Ronacher (`mitsuhiko`)**.

The original work is licensed under the **Apache License 2.0**. This maintained derivative remains Apache-2.0 licensed, preserves the upstream license in [LICENSE](LICENSE), and identifies modifications made for `@earendil-works/pi-ai` compatibility.
