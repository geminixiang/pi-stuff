---
name: native-web-search
description: "Search the web through the provider and model active in the current Pi session. Use for quick internet research that needs concise findings and full source URLs."
license: Apache-2.0
metadata:
  author: Armin Ronacher (mitsuhiko)
  source: https://github.com/mitsuhiko/agent-stuff/tree/main/skills/native-web-search
---

# Native Web Search

> **Attribution:** Derived from Armin Ronacher's (`mitsuhiko`) [`native-web-search`](https://github.com/mitsuhiko/agent-stuff/tree/main/skills/native-web-search), licensed under the [Apache License 2.0](../../LICENSE). This maintained version includes modifications for `@earendil-works/pi-ai` compatibility.

Run the bundled script with a focused query and explain why the result is needed. Pi does not change the shell working directory when it loads a skill, so use the concrete skill directory shown in Pi's skill read result:

```bash
cd "<native-web-search skill directory shown by Pi>" && \
  node search.mjs "<what to search>" --purpose "<why you need this>"
```

Do not run `node search.mjs` from the project root.

Examples:

```bash
cd "<native-web-search skill directory shown by Pi>" && \
  node search.mjs "latest Python release" --purpose "update dependency notes"
cd "<native-web-search skill directory shown by Pi>" && \
  node search.mjs "Vite 7 breaking changes" --purpose "prepare a migration checklist"
```

Optional flags:

- `--provider <provider-id>` to intentionally override the current Pi session
- `--model <model-id>`
- `--timeout <milliseconds>` (minimum 1000; default 120000)
- `--json`

The script uses the current Pi session's `PI_PROVIDER` and `PI_MODEL` by default. Built-in `openai-codex` and `anthropic` providers use their native web-search transports. Other active providers are looked up by their actual ID in `models.json` and use an OpenAI Responses-compatible `/responses` endpoint. Pass `--provider` only when you intentionally want to override the current session.

For configured providers, the script reads the provider's base URL, model, and API-key reference from `models.json`. For direct providers, it reuses credentials in Pi's `auth.json`. It prefers `@earendil-works/pi-ai` but retains compatibility with legacy `@mariozechner/pi-ai` installations.

If automatic module discovery fails, set:

- `PI_AI_MODULE_PATH` to pi-ai's `dist/index.js`
- `PI_AI_OAUTH_MODULE_PATH` to pi-ai's `dist/oauth.js`

Present the returned research summary to the user. Preserve full canonical URLs and explicitly note disagreements between sources.
