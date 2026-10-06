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
- `count`: number of separate output images (default `1`). Must be a positive safe integer; the extension does not impose a fixed output-count cap. Provider quotas, capabilities, and timeouts still apply.
- `outputFormat`: `png` (default), `jpeg`, or `webp`
- `model`: optional GPT 5.5+ model override resolved under the active provider. By default, it uses the active model. The provider selects the hosted image backend; the request does not pin an image model.
- `referencedImagePaths`: up to five local PNG, JPEG, or WebP paths for Responses providers; relative paths resolve from the current working directory
- `numLastImagesToInclude`: include one to five recent conversation images for Responses providers

Every successful generation is returned inline and written to:

```text
~/.pi/agent/generated-images/<session-id>/<image-call-id-or-uuid>.<ext>
```

The provider image-call ID is used when available. Otherwise the extension generates a UUID. Multiple-output requests prefix filenames with their sequence number to avoid collisions within a batch.

### Multiple images and progress

Ask Pi to generate multiple separate images, or call `gpt_image` with `{ "prompt": "Two separate minimalist geometric illustrations", "count": 2 }`.

- Responses providers receive instructions to make `count` separate hosted image calls in one request, not a collage. No unsupported `n` field is added to the hosted tool. The provider may execute those calls sequentially.
- As each multi-output image completes, it is validated and saved immediately. Cumulative tool updates include `Completed X/N`, file paths, and all completed image blocks. Pi displays previews when the client/terminal supports images; other clients receive the same progress updates. Providers that only return images at the terminal event cannot provide early previews.
- Cancellation or later failures preserve images already saved and return a partial error with their paths. Under- or over-delivery is reported explicitly; the extension does not automatically retry to fill missing images and incur more generation usage.
- Normalized `/images/generations` requests use `n` for counts above one and retain all returned images. That endpoint is not streamed; progress is available only after the JSON response arrives. Support for `n` is provider-dependent.
- Final results include every completed image, `details.savedPaths`, `details.generatedImages`, and requested/completed counts. The original singular detail fields describe the first image for compatibility.

## Native Responses compatibility

Native Responses calls use public `ctx.modelRegistry.streamSimple()` with `onPayload` replacement and an asynchronous `onProviderStreamEvent` collector. Pi owns request-time auth, resolved base URLs, headers, provider-scoped environment, HTTP transport, parsing, and stream errors. Codex explicitly uses SSE, not WebSocket. Custom Responses providers must implement both hooks; unsupported hooks, missing terminal events, unfinished images, and conflicting results fail rather than silently succeeding. Multi-output requests retain completed images if a later error occurs. An item repeated in the terminal output is collected only once.

- Native requests allow up to three adapter-managed retries and a 30-second server-delay limit. Retryable errors and backoff are adapter-specific, not identical to the previous extension retry loop; excessive server delays fail rather than being clamped. Normalized generation transport and retries are unchanged.
- Verified offline against Pi 1.0.4's public OpenAI, Azure, and Codex pipelines with fake fetch. Live generation/editing has also succeeded with OpenAI Codex and CLIProxyAPI; a live Codex multi-output request returned cumulative image updates. Other services and normalized multi-output support remain unverified. OpenAI/Azure SDK parsers handle split-byte UTF-8 and CRLF; Pi 1.0.4's Codex parser requires LF framing and rejects CRLF streams. Native calls also inherit Pi 1.0.4's header merge limitation: auth-resolved nulls cannot suppress model-default headers that adapters reapply.
- Native `details.endpoint` is `"provider-managed Responses endpoint"`, not a guessed URL (Azure/provider configuration may resolve it inside the adapter). `backendImageModel` is unset: neither native nor normalized requests ever pinned `gpt-image-2`, so the old label was not evidence of the actual backend. Payload behavior is unchanged; no explicit image-model selection was added.
- Raw upstream usage remains in `details.usage`; it is not added to Pi session totals. Pi's normalized chat token cost is not an image-billing estimate.

## Security and privacy

The extension sends prompts and selected reference images to the active model's configured image endpoint. It validates returned base64 and image magic bytes before returning or writing data. It does not collect telemetry or log provider credentials.

## Development

```sh
npm test --workspace @geminixiang/pi-gpt-image
npm run check --workspace @geminixiang/pi-gpt-image
```

## License

MIT
