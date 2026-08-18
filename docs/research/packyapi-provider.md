# PackyAPI provider for Pi and native web search

> **Superseded:** This research predates `packages/pi-packyapi`. The maintained integration is now the provider extension documented in [`packages/pi-packyapi/README.md`](../../packages/pi-packyapi/README.md). Install that package, remove the old `providers.packyapi` block from user `models.json`, and use Pi's `/login` flow. The material below is retained as historical endpoint research.

## Conclusion

`packyapi` should remain a normal custom provider in Pi's `models.json`; it does not need a provider-specific branch in `pi-native-web-search`. When a Pi session exposes `PI_PROVIDER=packyapi` and `PI_MODEL=gpt-5.5`, the script can resolve the provider by that actual ID and call its configured `baseUrl` with the OpenAI Responses transport.

PackyAPI's public pricing metadata verifies that `gpt-5.5` supports both its `openai` and `openai-response` endpoint types. PackyAPI publishes those endpoint mappings as:

- `openai` → `POST /v1/chat/completions`
- `openai-response` → `POST /v1/responses`

Source: https://www.packyapi.com/api/pricing

PackyAPI's official Codex setup uses `https://cf.api.fan/v1`, `wire_api = "responses"`, and enables `web_search_request = true`. Together with the public endpoint metadata, this is strong first-party evidence that PackyAPI's Codex route is intended to support Responses-based web search. A live authenticated request is still the final compatibility check for the exact token group and model.

Source: https://docs.packyapi.ai/docs/cli/3-codex.html

## Recommended `models.json` declaration

Keep the key outside JSON and reference an environment variable:

```json
{
  "providers": {
    "packyapi": {
      "baseUrl": "https://cf.api.fan/v1",
      "apiKey": "$PACKYAPI_API_KEY",
      "api": "openai-responses",
      "models": [
        {
          "id": "gpt-5.5",
          "name": "gpt-5.5",
          "reasoning": true,
          "contextWindow": 1050000
        }
      ]
    }
  }
}
```

Use the existing verified `maxOutputTokens` value in your local configuration; it was intentionally redacted during inspection and is not established by the public pricing endpoint.

Pi officially accepts both `openai-completions` and `openai-responses` for custom providers. Setting `api` to `openai-responses` makes ordinary Pi model calls use Responses too. Leaving it as `openai-completions` is also valid for ordinary Pi calls and does not prevent `pi-native-web-search` from explicitly calling `/responses`.

Pi source documentation: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md

## Endpoint choice

PackyAPI's current public announcement asks users to migrate model traffic away from the main website endpoints to globally routed endpoints:

- `https://cf.api.fan`
- `https://slb-v1.api.fan`

It says the main `www.packyapi.com` and `www.packyapi.ai` hosts will apply regional restrictions to model calls. Therefore `https://cf.api.fan/v1` is the safer default than `https://www.packyapi.com/v1` unless PackyAPI has given the account a different endpoint.

Source: https://www.packyapi.com/api/status (the `announcements` field)

## Provider selection behavior

The intended resolution order in `pi-native-web-search` is:

1. explicit `--provider` override;
2. current session `PI_PROVIDER`;
3. Pi `settings.json` default provider;
4. available direct credentials.

For a `packyapi` session, the script looks up `models.json.providers.packyapi` and uses `PI_MODEL` as the model ID. No internal provider alias is required.

## Safe validation

First verify that Pi can see the model without printing credentials:

```bash
pi --provider packyapi --model gpt-5.5 --print "Reply with exactly: ok"
```

Then run native web search from a Pi session whose active provider is PackyAPI, or explicitly override it for diagnosis:

```bash
node skills/native-web-search/search.mjs \
  "What is the latest Node.js LTS release?" \
  --purpose "verify PackyAPI web search" \
  --provider packyapi \
  --model gpt-5.5
```

The second command consumes API quota. A successful answer with current sources verifies that PackyAPI accepts the Responses built-in `web_search` tool. An error such as an unsupported tool/type means PackyAPI supports `/responses` but does not pass through that hosted tool for the selected channel.

Do not print `models.json`, shell-expand the key, enable HTTP wire tracing, or include authorization headers in diagnostics.

## Credential note

A literal API key in `models.json` works, but `$PACKYAPI_API_KEY` or a `!command` keychain reference is safer. Pi's custom-model documentation supports `$ENV_VAR` and `!command` resolution for provider API keys.

Source: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md
