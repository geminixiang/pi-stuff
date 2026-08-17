# Changelog

## 0.1.0

- Add the `gpt_image` Pi tool for generating and editing images through the active GPT 5.5+ provider.
- Route normalized providers through `/images/generations` and native Responses providers through the `image_generation` hosted tool.
- Persist every successful image under `~/.pi/agent/generated-images/<session-id>/`, using the provider image ID or a UUID filename.
- Add strict image validation, SSE parsing, reference-image support for Responses providers, and transient-request retries.
