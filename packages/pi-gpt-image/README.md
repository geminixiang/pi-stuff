# @geminixiang/pi-gpt-image

Generate and edit images in [Pi](https://pi.dev) through the active GPT provider's image API, backed by the provider's hosted image-generation capability. Authentication, headers, and endpoint selection come from Pi's active provider configuration—no separate API key or hard-coded `openai-codex` provider is required.

The active model must be GPT 5.5 or newer, including `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. For example, when Pi is using `agent-model/gpt-5.6-sol`, `gpt_image` calls the configured `agent-model` endpoint at `/v1/images/generations` with `agent-model` authentication. Providers using a native Responses API instead receive the `image_generation` hosted-tool request. An explicit `model` override is resolved under the same active provider.

## Install

```sh
pi install npm:@geminixiang/pi-gpt-image
```

Use Pi with a provider that exposes GPT 5.5+ and supports the Responses `image_generation` hosted tool. The extension reuses that provider's configured authentication.

It can edit either up to five local images (`referencedImagePaths`) or the most recent one to five conversation images (`numLastImagesToInclude`) when the active provider uses the native Responses API. The normalized `/images/generations` API currently supports generation only. Reference-input modes are mutually exclusive.

## Tool options

- `prompt` (required): detailed generation or editing instructions
- `outputFormat`: `png` (default), `jpeg`, or `webp`
- `model`: optional GPT 5.5+ model override resolved under the active provider. By default, it uses the active model. The hosted image model remains gpt-image-2.
- `referencedImagePaths`: up to five local PNG, JPEG, or WebP paths for Responses providers; relative paths resolve from the current working directory
- `numLastImagesToInclude`: include one to five recent conversation images for Responses providers

Every successful generation is returned inline and written to:

```text
~/.pi/agent/generated-images/<session-id>/<image-call-id-or-uuid>.<ext>
```

The provider image-call ID is used when available. Otherwise the extension generates a UUID, so successive images never overwrite one another.

## Security and privacy

The extension sends prompts and selected reference images to the active model's configured image endpoint. It validates returned base64 and image magic bytes before returning or writing data. It does not collect telemetry or log provider credentials.

## Development

```sh
npm test --workspace @geminixiang/pi-gpt-image
npm run check --workspace @geminixiang/pi-gpt-image
```

## License

MIT
