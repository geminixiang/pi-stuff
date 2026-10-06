# Changelog

## 0.2.1 - 2026-10-06

- Delegate native Responses requests to Pi’s public model registry, using request-time provider auth/configuration and SSE transport; remove extension-owned native HTTP, JWT, and SSE handling. Normalized `/images/generations` transport is unchanged.
- Collect completed hosted images before normalization, including terminal-only output; deduplicate repeated items and reject stream errors, cancellation, missing hooks/terminal events, unfinished images, and conflicting results.
- Keep three native retries with a 30-second server-delay limit, now using adapter-specific policies: excessive delays fail instead of being clamped.
- Correct the unverified `gpt-image-2` backend label without changing the hosted-tool payload; native endpoint metadata is provider-managed and raw usage remains in result details.
- Add offline public-pipeline coverage for OpenAI, Azure, and Codex. Document custom-provider hook requirements and inherited Pi 1.0.4 limitations (Codex LF-only SSE and auth-null/model-header merging); live hosted-service support is not verified.

## 0.2.0 - 2026-10-06

- Require Pi 1.x (>=1.0.0 <2.0.0); develop and verify against Pi 1.0.4.
- Omit null provider header overrides when building image requests.

## 0.1.1 - 2026-10-06

- Maintenance release to verify npm trusted publishing; no functional changes.

## 0.1.0 - 2026-10-06

- Add the `gpt_image` Pi tool for generating and editing images through the active GPT 5.5+ provider.
- Route normalized providers through `/images/generations` and native Responses providers through the `image_generation` hosted tool.
- Persist every successful image under `~/.pi/agent/generated-images/<session-id>/`, using the provider image ID or a UUID filename.
- Add strict image validation, SSE parsing, reference-image support for Responses providers, and transient-request retries.
