# Changelog

## 0.2.0

- Expand the supported catalog from four to 14 explicitly mapped and transport-validated PackyAPI models.
- Generate capability metadata from models.dev while keeping PackyAPI as the exclusive source for costs, groups, and endpoints.
- Select Responses, OpenAI Completions, or Anthropic Messages per PackyAPI endpoint metadata.
- Keep Claude models hidden when PackyAPI restricts them to the official Claude Code client.
- Report visible unsupported models without exposing guessed capabilities.
- Check both PackyAPI pricing and models.dev capability drift.

## 0.1.0

- Add the PackyAPI provider with secure `/login` API-key entry and environment-variable auth.
- Add a curated Responses catalog for DeepSeek V4 Flash and three GPT-5.6 variants.
- Add the Codex-compatible client identity required by PackyAPI's Responses endpoint.
- Add a deterministic, version-controlled catalog generated from PackyAPI public pricing.
- Separate public pricing facts from manually verified model capability metadata.
- Add public catalog freshness and optional authenticated model-visibility checks.
