# @geminixiang/pi-packyapi

A [Pi](https://github.com/earendil-works/pi) provider extension for PackyAPI. It provides `/login` API-key entry and a version-controlled catalog assembled from PackyAPI and models.dev.

## Install

```sh
pi install npm:@geminixiang/pi-packyapi
```

Run `/login`, select **PackyAPI**, and enter your API key. Alternatively set `PACKYAPI_API_KEY` for the Pi process. If `~/.pi/agent/models.json` already contains `providers.packyapi`, remove that provider block after installing: Pi composes that local definition above extension providers and it would replace this catalog.

## Data ownership

| Data                                                                                | Authoritative source                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Raw quota costs, token groups, supported endpoints                                  | [PackyAPI pricing](https://www.packyapi.com/api/pricing)                        |
| CNY/USD exchange rate                                                               | [PackyAPI status](https://www.packyapi.com/api/status)                          |
| CNY paid per quota unit                                                             | [PackyAPI top-up policy](https://docs.packyapi.ai/docs/register/3-quota.html)   |
| Models visible to a particular token                                                | Authenticated PackyAPI `/v1/models`                                             |
| Display name, reasoning, text/image input, context/output limits, reasoning options | [models.dev](https://models.dev/api.json), through `catalog/model-mapping.json` |
| Ambiguous ID mappings, Pi API/compat exceptions, Responses client identity          | Committed local mapping/overrides                                               |

models.dev costs are intentionally discarded. Raw `quotaCost` values per million tokens use only PackyAPI's ratios (`input = model_ratio × 2`; output, cache-read, and cache-write are derived from PackyAPI completion, cache, and `cache_creation_ratio_5m` values).

Pi receives a real USD-equivalent `cost`, calculated as:

```text
cost = quotaCost × CNY_PER_QUOTA ÷ usd_exchange_rate
```

`CNY_PER_QUOTA` is a committed policy constant of `1`, based on PackyAPI's current [top-up documentation](https://docs.packyapi.ai/docs/register/3-quota.html): 1 CNY purchases 1 USD-named quota unit. The exchange rate is fetched from PackyAPI `/api/status` (currently 7 CNY/USD). For example, a raw cost of 5 quota per million tokens becomes `5 × 1 ÷ 7 = US$0.714285714286` per million tokens.

These are **base** USD-equivalent costs. Token-group and peak-pricing multipliers are intentionally not applied because they vary by credential and request time, so actual usage cost can differ. The generated catalog preserves both auditable `quotaCost` and converted `cost`, but the runtime provider passes only `cost` to Pi.

Endpoint selection also comes only from PackyAPI: `openai-response` is preferred, then `openai`, then `anthropic`. The Codex-compatible `User-Agent: codex_exec` is applied only to Responses models. Anthropic-only models use the Claude-compatible identity required by PackyAPI.

## Support policy

The extension supports only PackyAPI IDs with an explicit, reviewable models.dev mapping and a transport that works through Pi. It currently supports 14 models across DeepSeek, GLM, GPT, Grok, Kimi, and MiniMax. Nine visible Claude models remain unsupported because PackyAPI restricts them to the official Claude Code client; `codex-auto-review` remains unsupported because it has no defensible models.dev capability match. Newly visible but unsupported IDs are reported by the authenticated check and are not guessed or silently exposed.

Pi supports text and image model inputs, so models.dev `video` and `pdf` modalities are ignored. Reasoning levels are advertised only when models.dev explicitly lists the corresponding effort; local overrides are reserved for verified transport exceptions.

## Maintaining the catalog

`catalog/model-mapping.json` is the single explicit supported-ID list. To fetch PackyAPI pricing and status plus models.dev capabilities, then deterministically regenerate `catalog/models.json`:

```sh
npm run models:sync
```

Review and commit the generated diff. It contains no `generatedAt`, credential, or token-scoped response.

Check committed pricing, exchange-rate, and capability metadata for drift without writing:

```sh
npm run models:check
```

Optionally verify token visibility. This does not update the catalog and does not log the key or full response:

```sh
PACKYAPI_API_KEY='...' npm run models:check-auth
```

Before release, test the package through Pi's real extension loader:

```sh
npm run smoke:pi
```
