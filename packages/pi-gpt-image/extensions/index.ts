import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum, type Model, type ProviderHeaders } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const MINIMUM_GPT_MAJOR = 5;
const MINIMUM_GPT_MINOR = 5;
const MAX_IMAGES = 5;
const MAX_RETRIES = 3;
const MAX_DELAY_MS = 30_000;

const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

const parameters = Type.Object({
  prompt: Type.String({ description: "Detailed image generation or editing instructions." }),
  count: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Number of separate output images. Defaults to 1; provider limits apply. Images may be generated sequentially.",
    }),
  ),
  outputFormat: Type.Optional(StringEnum(OUTPUT_FORMATS)),
  model: Type.Optional(
    Type.String({
      description:
        "GPT 5.5+ model ID. Defaults to the active model; an override must exist under the active provider.",
    }),
  ),
  referencedImagePaths: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_IMAGES })),
  numLastImagesToInclude: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_IMAGES })),
});
type GptImageParams = Static<typeof parameters>;

export function isImageCapableGptModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/i.exec(modelId.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > MINIMUM_GPT_MAJOR || (major === MINIMUM_GPT_MAJOR && minor >= MINIMUM_GPT_MINOR);
}

export function resolveRoutingModel(
  requestedModel: string | undefined,
  activeModelId: string | undefined,
): string {
  const model = requestedModel?.trim() || activeModelId?.trim();
  if (!isImageCapableGptModel(model)) {
    throw new Error(
      "gpt_image requires the active or explicitly selected model to be GPT 5.5 or newer.",
    );
  }
  return model as string;
}

export function usesNativeResponses(model: Model<any>): boolean {
  return [
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
    "cliproxyapi-codex-responses",
  ].includes(model.api);
}

export function resolveImageUrl(model: Model<any>): string {
  const baseUrl = model.baseUrl.replace(/\/+$/, "");
  return baseUrl.endsWith("/images/generations") ? baseUrl : `${baseUrl}/images/generations`;
}

function hasHeader(headers: Headers, name: string): boolean {
  return [...headers.keys()].some((key) => key.toLowerCase() === name.toLowerCase());
}

export async function buildRequestHeaders(
  _model: Model<any>,
  getAuth: () => Promise<
    { ok: true; apiKey?: string; headers?: ProviderHeaders } | { ok: false; error: string }
  >,
): Promise<Headers> {
  const auth = await getAuth();
  if (!auth.ok) throw new Error(auth.error);
  const headers = new Headers();
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (value !== null) headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream, application/json");
  if (auth.apiKey && !hasHeader(headers, "authorization")) {
    headers.set("authorization", `Bearer ${auth.apiKey}`);
  }
  return headers;
}
interface InputImage {
  data: string;
  mimeType: string;
}
interface GeneratedImage {
  id?: string;
  outputIndex?: number;
  status: string;
  result: string;
  revisedPrompt?: string;
}
interface ParsedResponse {
  image?: GeneratedImage;
  images?: GeneratedImage[];
  text: string[];
  responseId?: string;
  usage?: unknown;
}

export function resolveInputPath(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export function sanitizePathPart(value: string, fallback: string): string {
  const safe = value
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return safe || fallback;
}

function magicMime(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return undefined;
}

export function decodeImageData(data: string, format?: OutputFormat): Buffer {
  const value = data.trim();
  if (
    !value ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("Codex returned invalid base64 image data.");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== value)
    throw new Error("Codex returned invalid base64 image data.");
  const mime = magicMime(bytes);
  const expected = format === "jpeg" ? "image/jpeg" : format ? `image/${format}` : undefined;
  if (!mime || (expected && mime !== expected))
    throw new Error(`Image data does not match ${format ?? "a supported image format"}.`);
  return bytes;
}

export function selectRecentImages(messages: unknown[], count: number): InputImage[] {
  const found: InputImage[] = [];
  for (let i = messages.length - 1; i >= 0 && found.length < count; i--) {
    const message = messages[i] as { content?: unknown };
    if (!Array.isArray(message?.content)) continue;
    for (let j = message.content.length - 1; j >= 0 && found.length < count; j--) {
      const part = message.content[j] as { type?: unknown; data?: unknown; mimeType?: unknown };
      if (
        part?.type === "image" &&
        typeof part.data === "string" &&
        typeof part.mimeType === "string"
      ) {
        const bytes = decodeImageData(part.data);
        found.push({ data: bytes.toString("base64"), mimeType: magicMime(bytes) as string });
      }
    }
  }
  return found.reverse();
}

export async function resolveInputImages(
  params: GptImageParams,
  cwd: string,
  messages: unknown[],
): Promise<InputImage[]> {
  const paths = params.referencedImagePaths ?? [];
  if (paths.length && params.numLastImagesToInclude !== undefined)
    throw new Error("Use either referencedImagePaths or numLastImagesToInclude, not both.");
  if (paths.length > MAX_IMAGES)
    throw new Error(`referencedImagePaths accepts at most ${MAX_IMAGES} paths.`);
  if (paths.length) {
    return Promise.all(
      paths.map(async (path) => {
        const absolute = resolveInputPath(cwd, path);
        let bytes: Buffer;
        try {
          bytes = await readFile(absolute);
        } catch (error) {
          throw new Error(
            `Unable to read referenced image at ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const mimeType = magicMime(bytes);
        if (!mimeType) throw new Error(`Referenced image is unsupported: ${absolute}`);
        return { data: bytes.toString("base64"), mimeType };
      }),
    );
  }
  if (params.numLastImagesToInclude !== undefined) {
    const count = params.numLastImagesToInclude;
    if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES)
      throw new Error(`numLastImagesToInclude must be between 1 and ${MAX_IMAGES}.`);
    const images = selectRecentImages(messages, count);
    if (images.length !== count)
      throw new Error(
        `Requested ${count} recent conversation images, but only ${images.length} were available.`,
      );
    return images;
  }
  return [];
}

export function buildImageGenerationsBody(
  params: GptImageParams,
  model: string,
): Record<string, unknown> {
  return {
    model,
    prompt: params.prompt,
    response_format: "b64_json",
    ...(params.count && params.count > 1 ? { n: params.count } : {}),
    output_format: params.outputFormat ?? "png",
  };
}

export function buildRequestBody(
  params: GptImageParams,
  model: string,
  format: OutputFormat,
  sessionId: string,
  images: InputImage[] = [],
) {
  return {
    model,
    store: false,
    stream: true,
    prompt_cache_key: sessionId,
    instructions:
      (params.count ?? 1) === 1
        ? "Call the image_generation tool exactly once to generate or edit the requested bitmap image."
        : `Call image_generation exactly ${params.count} times to generate or edit ${params.count} separate bitmap images. Each call must produce one image, not a collage. Complete all image calls before responding.`,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: params.prompt },
          ...images.map((image) => ({
            type: "input_image",
            image_url: `data:${image.mimeType};base64,${image.data}`,
          })),
        ],
      },
    ],
    tools: [{ type: "image_generation", output_format: format }],
    tool_choice: "auto",
    parallel_tool_calls: (params.count ?? 1) > 1,
    text: { verbosity: "low" },
  };
}

export async function parseImageGenerationJson(response: Response): Promise<ParsedResponse> {
  const payload = (await response.json()) as {
    model?: unknown;
    data?: Array<{ b64_json?: unknown; revised_prompt?: unknown }>;
    usage?: unknown;
  };
  const images: GeneratedImage[] = (payload.data ?? []).map((item) => {
    if (typeof item.b64_json !== "string" || !item.b64_json)
      throw new Error("The active provider returned invalid base64 image data.");
    return {
      status: "completed",
      result: item.b64_json,
      revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
    };
  });
  if (!images.length) throw new Error("The active provider returned no base64 image data.");
  return {
    image: images[0],
    images,
    text: [],
    usage: payload.usage,
  };
}

async function requestNativeImage(
  registry: ExtensionContext["modelRegistry"],
  model: Model<any>,
  request: ReturnType<typeof buildRequestBody>,
  signal?: AbortSignal,
  count = 1,
  onImage?: (image: GeneratedImage) => Promise<void>,
): Promise<ParsedResponse> {
  const parsed: ParsedResponse = { text: [], images: [] };
  let payloadReplaced = false;
  let sawRawEvent = false;
  let completed = false;
  async function collectImage(value: unknown, outputIndex?: number) {
    const item = value as Record<string, unknown> | undefined;
    if (item?.type !== "image_generation_call") return;
    if (item.status !== "completed")
      throw new Error(`Image generation did not complete (status: ${String(item.status)}).`);
    if (typeof item.result !== "string" || !item.result)
      throw new Error("Image generation result contained no image data.");
    const id = typeof item.id === "string" ? item.id : undefined;
    const previous = parsed.images!.find((image) =>
      id
        ? image.id === id
        : image.id === undefined &&
          (outputIndex !== undefined
            ? image.outputIndex === outputIndex
            : image.result === item.result),
    );
    if (previous) {
      if (previous.result === item.result) return;
      throw new Error("Received conflicting image generation results for the same image ID.");
    }
    if (count === 1 && parsed.images!.length)
      throw new Error(
        "Expected exactly one image generation result; received multiple or conflicting images.",
      );
    const image: GeneratedImage = {
      id,
      outputIndex,
      status: "completed",
      result: item.result,
      revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
    };
    decodeImageData(image.result);
    parsed.images!.push(image);
    parsed.image ??= image;
    await onImage?.(image);
  }
  const stream = registry.streamSimple(
    model,
    {
      // The full prompt and image inputs are supplied by onPayload below.
      messages: [],
    },
    {
      signal,
      sessionId: request.prompt_cache_key,
      transport: "sse",
      maxRetries: MAX_RETRIES,
      maxRetryDelayMs: MAX_DELAY_MS,
      onPayload(payload) {
        if (signal?.aborted) throw new Error("Image generation was aborted.");
        payloadReplaced = true;
        // Preserve adapter-resolved routing (notably Azure deployment names), not its chat payload.
        const routingModel = (payload as { model?: unknown })?.model;
        return { ...request, model: typeof routingModel === "string" ? routingModel : model.id };
      },
      async onProviderStreamEvent(value) {
        if (!value || typeof value !== "object") return;
        const event = value as Record<string, unknown>;
        if (typeof event.type !== "string") return;
        sawRawEvent = true;
        const response = event.response as
          | { id?: string; status?: string; usage?: unknown; output?: unknown[] }
          | undefined;
        if (
          event.type === "response.created" ||
          event.type === "response.completed" ||
          event.type === "response.done"
        ) {
          if (typeof response?.id === "string") parsed.responseId = response.id;
          if (response?.usage !== undefined) parsed.usage = response.usage;
        }
        if (event.type === "response.completed" || event.type === "response.done") {
          if (response?.status !== "completed")
            throw new Error(
              `Image response did not complete (status: ${String(response?.status)}).`,
            );
          completed = true;
          for (const [index, item] of (response.output ?? []).entries())
            await collectImage(item, index);
        }
        if (event.type === "response.output_item.done")
          await collectImage(
            event.item,
            typeof event.output_index === "number" ? event.output_index : undefined,
          );
        if (event.type === "response.output_text.delta" && typeof event.delta === "string")
          parsed.text.push(event.delta);
      },
    },
  );
  // Drain normalized events as well: result() alone leaves their queue retained in memory.
  for await (const _event of stream) {
    /* collected before normalization */
  }
  const result = await stream.result();
  if (signal?.aborted || result.stopReason === "aborted")
    throw new Error("Image generation was aborted.");
  if (result.stopReason === "error")
    throw new Error(result.errorMessage || "Image generation provider stream failed.");
  if (!payloadReplaced || !sawRawEvent)
    throw new Error(
      "This Responses provider must support onPayload replacement and onProviderStreamEvent raw events.",
    );
  if (!completed || result.stopReason !== "stop")
    throw new Error(
      `Image generation ended without a successful completed response (${result.stopReason}).`,
    );
  return parsed;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Math.min(Number(value) * 1000, MAX_DELAY_MS);
  const date = Date.parse(value);
  return Number.isFinite(date) && date > now ? Math.min(date - now, MAX_DELAY_MS) : undefined;
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Image generation was aborted."));
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(done, ms);
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
    function done() {
      cleanup();
      resolvePromise();
    }
    function abort() {
      cleanup();
      reject(new Error("Image generation was aborted."));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function requestImage(
  url: string,
  headers: Headers,
  body: unknown,
  signal?: AbortSignal,
): Promise<ParsedResponse> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error("Image generation was aborted.");
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal,
        body: JSON.stringify(body),
        headers,
      });
    } catch (error) {
      if (signal?.aborted || attempt === MAX_RETRIES) throw error;
      await abortableDelay(Math.min(1000 * 2 ** attempt, MAX_DELAY_MS), signal);
      continue;
    }
    if (response.ok) {
      return parseImageGenerationJson(response);
    }
    const text = await response.text();
    if (attempt === MAX_RETRIES || ![429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(
        `Image generation request failed (${response.status}): ${text.slice(0, 1000)}`,
      );
    }
    const delay =
      parseRetryAfter(response.headers.get("retry-after")) ??
      Math.min(1000 * 2 ** attempt, MAX_DELAY_MS);
    await abortableDelay(delay, signal);
  }
  throw new Error("Image generation request failed after retries.");
}

function outputDirectory(session: string, agentDir: string): string {
  return join(agentDir, "generated-images", session);
}

export function imageFileName(imageId: string | undefined, extension: string): string {
  const safeId = imageId ? sanitizePathPart(imageId, "") : "";
  return `${safeId || randomUUID()}.${extension}`;
}

export default function gptImageExtension(pi: ExtensionAPI, agentDir = getAgentDir()) {
  pi.registerTool({
    name: "gpt_image",
    label: "GPT Image",
    description:
      "Generate or edit an image through the active GPT 5.5+ provider's hosted image_generation tool, or generate through its normalized /images/generations API. Uses the active provider's endpoint and authentication, including custom providers such as agent-model, supports multiple outputs via count with cumulative completed-image progress, and accepts up to five local or recent conversation reference images.",
    promptSnippet:
      "Generate or edit bitmap images through the active GPT provider's hosted image tool.",
    promptGuidelines: [
      "Use gpt_image when the user asks to generate or edit a raster image.",
      "Do not invoke gpt_image without a clear image request because it consumes the provider's image quota or billing.",
    ],
    parameters,
    executionMode: "parallel",
    async execute(_toolCallId, params: GptImageParams, signal, onUpdate, ctx) {
      const count = params.count ?? 1;
      if (!Number.isSafeInteger(count) || count < 1)
        throw new Error("count must be a positive safe integer.");
      const requestedModel = resolveRoutingModel(params.model, ctx.model?.id);
      const provider = ctx.model?.provider;
      if (!provider) throw new Error("gpt_image requires an active GPT model.");
      const model =
        ctx.model?.id === requestedModel
          ? ctx.model
          : ctx.modelRegistry.find(provider, requestedModel);
      if (!model) {
        throw new Error(`Model ${provider}/${requestedModel} is not configured in Pi.`);
      }
      const modelId = model.id;
      const format = params.outputFormat ?? "png";
      const nativeResponses = usesNativeResponses(model);
      const endpoint = nativeResponses
        ? "provider-managed Responses endpoint"
        : resolveImageUrl(model);
      const session = sanitizePathPart(ctx.sessionManager.getSessionId(), "session");
      const messages: unknown[] = [];
      if (nativeResponses && params.numLastImagesToInclude !== undefined) {
        for (const entry of ctx.sessionManager.getBranch()) {
          if (entry.type === "message") messages.push(entry.message);
          else if (entry.type === "custom_message") messages.push(entry);
        }
      }
      const images = nativeResponses
        ? await resolveInputImages(params, ctx.cwd, messages)
        : params.referencedImagePaths?.length
          ? await resolveInputImages(params, ctx.cwd, messages)
          : [];
      if (images.length && !nativeResponses) {
        throw new Error(
          `${provider}/${model.id} exposes image generation through /images/generations, which does not accept reference images. Switch to a Responses provider to edit images.`,
        );
      }
      const saved: Array<{
        image: GeneratedImage;
        savedPath: string;
        mimeType: string;
        outputFormat: OutputFormat;
      }> = [];
      let parsed: ParsedResponse | undefined;
      function result(text: string, isError = false) {
        const first = saved[0];
        return {
          isError,
          content: [
            { type: "text" as const, text },
            ...saved.map(({ image, mimeType }) => ({
              type: "image" as const,
              data: image.result,
              mimeType,
            })),
          ],
          details: {
            provider,
            model: modelId,
            endpoint,
            backendImageModel: undefined,
            requestedCount: count,
            completedCount: saved.length,
            outputFormat: first?.outputFormat,
            requestedOutputFormat: format,
            savedPath: first?.savedPath,
            savedPaths: saved.map((item) => item.savedPath),
            inputImageCount: images.length,
            responseId: parsed?.responseId,
            imageGenerationId: first?.image.id,
            revisedPrompt: first?.image.revisedPrompt,
            usage: parsed?.usage,
            generatedImages: saved.map(({ image, savedPath, mimeType, outputFormat }) => ({
              savedPath,
              mimeType,
              outputFormat,
              imageGenerationId: image.id,
              revisedPrompt: image.revisedPrompt,
            })),
          },
        };
      }
      async function saveImage(image: GeneratedImage) {
        if (signal?.aborted) throw new Error("Image generation was aborted.");
        const bytes = decodeImageData(image.result);
        const mimeType = magicMime(bytes) as string;
        const outputFormat: OutputFormat =
          mimeType === "image/jpeg" ? "jpeg" : mimeType === "image/webp" ? "webp" : "png";
        const directory = outputDirectory(session, agentDir);
        const savedPath = join(
          directory,
          `${count > 1 ? `${saved.length + 1}-` : ""}${imageFileName(image.id, outputFormat === "jpeg" ? "jpg" : outputFormat)}`,
        );
        await withFileMutationQueue(savedPath, async () => {
          await mkdir(directory, { recursive: true });
          await writeFile(savedPath, bytes);
        });
        saved.push({ image, savedPath, mimeType, outputFormat });
        // Updates replace the previous result in Pi, so retain all completed images.
        onUpdate?.(
          result(
            `Completed ${saved.length}/${count} images via ${provider}/${modelId}. Saved to ${savedPath}. Waiting for the provider to finish...`,
          ),
        );
      }
      onUpdate?.(
        result(
          `Requesting ${count} ${images.length ? "image edits" : "images"} through ${provider}/${model.id}. Completed 0/${count}; the provider may generate sequentially...`,
        ),
      );
      try {
        parsed = nativeResponses
          ? await requestNativeImage(
              ctx.modelRegistry,
              model,
              buildRequestBody(params, model.id, format, session, images),
              signal,
              count,
              count > 1 ? saveImage : undefined,
            )
          : await requestImage(
              endpoint,
              await buildRequestHeaders(model, () => ctx.modelRegistry.getApiKeyAndHeaders(model)),
              buildImageGenerationsBody(params, model.id),
              signal,
            );
        if (signal?.aborted) throw new Error("Image generation was aborted.");
        if (!parsed.image) {
          const text = parsed.text.join("").trim();
          throw new Error(
            text ? `Provider returned no image: ${text}` : "Provider returned no image.",
          );
        }
        if (!nativeResponses || count === 1)
          for (const image of parsed.images ?? [parsed.image]) await saveImage(image);
        if (saved.length !== count)
          return result(
            `Provider completed ${saved.length}/${count} requested images. All returned images were saved:\n${saved.map((item) => item.savedPath).join("\n")}. No automatic retry was made.`,
            true,
          );
        return result(
          `Generated ${saved.length} image${saved.length === 1 ? "" : "s"} via ${provider}/${model.id} using the provider image backend. Saved to ${saved.map((item) => item.savedPath).join(", ")}.`,
        );
      } catch (error) {
        if (!saved.length) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        return result(
          `Image generation stopped after ${saved.length}/${count} images: ${reason}\nCompleted images remain saved:\n${saved.map((item) => item.savedPath).join("\n")}`,
          true,
        );
      }
    },
  });
}
