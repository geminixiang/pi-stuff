# @geminixiang/pi-gpt-image

Generate and edit images in [Pi](https://pi.dev) with the native Codex `image_generation` hosted tool, backed by **gpt-image-2**. The extension reuses Pi's existing `openai-codex` OAuth login—no API key is needed—and works regardless of the provider selected for the current conversation.

## Install

```sh
pi install npm:@geminixiang/pi-gpt-image
```

Log in with `/login` and select **ChatGPT Plus/Pro (Codex)** if Pi does not already have `openai-codex` credentials.

Ask Pi to generate an image naturally, or explicitly request the `gpt_image` tool. It can edit either up to five local images (`referencedImagePaths`) or the most recent one to five conversation images (`numLastImagesToInclude`). Those input modes are mutually exclusive.

## Tool options

- `prompt` (required): detailed generation or editing instructions
- `size`: `1024x1024` (default), `1024x1536`, or `1536x1024`
- `outputFormat`: `png` (default), `jpeg`, or `webp`
- `model`: Codex routing model; defaults to `gpt-5.5` (the hosted image model remains gpt-image-2)
- `save`: `none`, `project`, `global` (default), or `custom`
- `saveDir`: directory for `custom`; relative paths resolve from the project
- `referencedImagePaths`: up to five local PNG, JPEG, or WebP files; an optional leading `@` is accepted
- `numLastImagesToInclude`: include one to five recent conversation images

A valid generated image is always returned inline. If saving fails, the result includes a warning instead of discarding the image.

## Configuration

Global config: `~/.pi/agent/extensions/gpt-image.json`

Project config: `.pi/extensions/gpt-image.json`

Project config is read only when Pi reports the project as trusted. It overlays global config:

```json
{
  "save": "global",
  "saveDir": "~/Pictures/generated",
  "model": "gpt-5.5"
}
```

Environment overrides:

- `PI_GPT_IMAGE_SAVE_MODE`
- `PI_GPT_IMAGE_SAVE_DIR`

Save locations are grouped by sanitized session ID. `project` writes under `.pi/generated-images/`; `global` writes under `~/.pi/agent/generated-images/`; `none` only returns the inline image.

## Security and privacy

The extension sends prompts and selected reference images to `https://chatgpt.com/backend-api/codex/responses`. It validates returned base64 and image magic bytes before returning or writing data. It does not collect telemetry or log OAuth credentials.

## Development

```sh
npm test --workspace @geminixiang/pi-gpt-image
npm run check --workspace @geminixiang/pi-gpt-image
```

## License

MIT
