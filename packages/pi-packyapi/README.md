# @geminixiang/pi-packyapi

A [Pi](https://github.com/earendil-works/pi) provider extension for PackyAPI. It uses PackyAPI's OpenAI Responses endpoint with the Codex-compatible client identity required by PackyAPI and intentionally exposes only a small curated model catalog.

## Install

```sh
pi install npm:@geminixiang/pi-packyapi
```

Run `/login` in Pi, select **PackyAPI**, and enter your API key. Pi stores the credential securely. Alternatively, set it for the Pi process:

```sh
export PACKYAPI_API_KEY='...'
```

Then select a PackyAPI model with `/model`.

If you previously configured `providers.packyapi` in `~/.pi/agent/models.json`, remove that provider block after installing this extension. Pi intentionally composes `models.json` above extension providers, so the old block would replace this package's curated model catalog. Run `/login` afterward to store the API key through Pi instead.

## Curated models

- `deepseek-v4-flash`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`

The version-controlled `catalog/models.json` contains PackyAPI's public model facts: supported endpoints, groups, and base cost per million tokens. Capability metadata that pricing cannot establish—context windows, output limits, modalities, reasoning controls, and compatibility—is maintained in `extensions/overrides.ts`.

Catalog costs are PackyAPI base costs derived from its public ratios. Actual billed costs can differ because PackyAPI may apply token-group and peak-pricing multipliers. Consult PackyAPI's current pricing before relying on estimates.

## Maintaining the catalog

Update public facts from PackyAPI's pricing endpoint:

```sh
npm run models:sync
```

This deterministically rewrites `catalog/models.json` for exactly the IDs already committed there. It does not read an API key or access Pi user configuration. Review and commit the generated diff.

Verify that the committed catalog matches current public pricing without writing files:

```sh
npm run models:check
```

To separately verify that a maintainer token can see every curated model through PackyAPI's token-scoped `/v1/models` endpoint:

```sh
PACKYAPI_API_KEY='...' npm run models:check-auth
```

The authenticated check does not update the catalog and never logs the key, headers, or full response. Use a secure environment injector rather than putting credentials in shell history.

Before release, verify the packaged extension through Pi's real extension loader:

```sh
npm run smoke:pi
```
