# Changelog

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
