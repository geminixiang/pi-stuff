import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum, type Model } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  getAgentDir,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const MINIMUM_GPT_MAJOR = 5;
const MINIMUM_GPT_MINOR = 5;
const IMAGE_MODEL = "gpt-image-2";
const AUTH_CLAIM = "https://api.openai.com/auth";
const MAX_IMAGES = 5;
const MAX_RETRIES = 3;
const MAX_DELAY_MS = 30_000;

const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

const parameters = Type.Object({
  prompt: Type.String({ description: "Detailed image generation or editing instructions." }),
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
  return ["openai-responses", "azure-openai-responses", "openai-codex-responses"].includes(
    model.api,
  );
}

export function resolveImageUrl(model: Model<any>): string {
  const baseUrl = model.baseUrl.replace(/\/+$/, "");
  if (usesNativeResponses(model)) {
    if (model.api === "openai-codex-responses") {
      if (baseUrl.endsWith("/codex/responses")) return baseUrl;
      if (baseUrl.endsWith("/codex")) return `${baseUrl}/responses`;
      return `${baseUrl}/codex/responses`;
    }
    return baseUrl.endsWith("/responses") ? baseUrl : `${baseUrl}/responses`;
  }
  return baseUrl.endsWith("/images/generations") ? baseUrl : `${baseUrl}/images/generations`;
}

function hasHeader(headers: Headers, name: string): boolean {
  return [...headers.keys()].some((key) => key.toLowerCase() === name.toLowerCase());
}

export async function buildRequestHeaders(
  model: Model<any>,
  getAuth: () => Promise<
    { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }
  >,
): Promise<Headers> {
  const auth = await getAuth();
  if (!auth.ok) throw new Error(auth.error);
  const headers = new Headers(auth.headers);
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream, application/json");
  if (auth.apiKey && !hasHeader(headers, "authorization")) {
    headers.set("authorization", `Bearer ${auth.apiKey}`);
  }
  if (model.api === "openai-codex-responses") {
    headers.set("OpenAI-Beta", "responses=experimental");
    headers.set("originator", "pi");
    if (auth.apiKey && !hasHeader(headers, "chatgpt-account-id")) {
      headers.set("chatgpt-account-id", decodeJwtAccountId(auth.apiKey));
    }
  }
  return headers;
}
interface InputImage {
  data: string;
  mimeType: string;
}
interface GeneratedImage {
  id?: string;
  status: string;
  result: string;
  revisedPrompt?: string;
}
interface ParsedResponse {
  image?: GeneratedImage;
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
      "Call the image_generation tool exactly once to generate or edit the requested bitmap image.",
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
    parallel_tool_calls: false,
    text: { verbosity: "low" },
  };
}

export async function parseImageGenerationJson(response: Response): Promise<ParsedResponse> {
  const payload = (await response.json()) as {
    model?: unknown;
    data?: Array<{ b64_json?: unknown; revised_prompt?: unknown }>;
    usage?: unknown;
  };
  const image = payload.data?.find((item) => typeof item.b64_json === "string");
  if (!image || typeof image.b64_json !== "string") {
    throw new Error("The active provider returned no base64 image data.");
  }
  return {
    image: {
      status: "completed",
      result: image.b64_json,
      revisedPrompt: typeof image.revised_prompt === "string" ? image.revised_prompt : undefined,
    },
    text: [],
    usage: payload.usage,
  };
}

function eventData(block: string): string | undefined {
  const value = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  return value && value !== "[DONE]" ? value : undefined;
}

function handleEvent(value: unknown, parsed: ParsedResponse): void {
  if (!value || typeof value !== "object") return;
  const event = value as Record<string, unknown>;
  if (event.type === "error")
    throw new Error(
      `Codex error: ${typeof event.message === "string" ? event.message : "unknown error"}`,
    );
  if (event.type === "response.failed") {
    const response = event.response as { error?: { message?: unknown } } | undefined;
    throw new Error(
      typeof response?.error?.message === "string"
        ? response.error.message
        : "Codex response failed.",
    );
  }
  if (event.type === "response.created" || event.type === "response.completed") {
    const response = event.response as { id?: unknown; usage?: unknown } | undefined;
    if (typeof response?.id === "string") parsed.responseId = response.id;
    if (response?.usage !== undefined) parsed.usage = response.usage;
  }
  if (event.type === "response.output_text.delta" && typeof event.delta === "string")
    parsed.text.push(event.delta);
  if (event.type === "response.output_item.done") {
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === "image_generation_call") {
      if (typeof item.result !== "string" || !item.result)
        throw new Error("Codex image generation result contained no image data.");
      parsed.image = {
        id: typeof item.id === "string" ? item.id : undefined,
        status: typeof item.status === "string" ? item.status : "completed",
        result: item.result,
        revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : undefined,
      };
    }
  }
}

export async function parseCodexSse(
  response: Response,
  signal?: AbortSignal,
): Promise<ParsedResponse> {
  if (!response.body) throw new Error("Codex response did not include a stream body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parsed: ParsedResponse = { text: [] };
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Image generation was aborted.");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const data = eventData(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (data) handleEvent(JSON.parse(data) as unknown, parsed);
      }
    }
    buffer += decoder.decode();
    const data = eventData(buffer);
    if (data) handleEvent(JSON.parse(data) as unknown, parsed);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    reader.releaseLock();
  }
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

function decodeJwtAccountId(token: string): string {
  try {
    const payload = token.split(".")[1];
    if (!payload) throw new Error();
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const auth = claims[AUTH_CLAIM] as Record<string, unknown> | undefined;
    if (typeof auth?.chatgpt_account_id === "string" && auth.chatgpt_account_id)
      return auth.chatgpt_account_id;
  } catch {
    /* normalized below */
  }
  throw new Error(
    "OpenAI Codex OAuth token has no ChatGPT account ID. Run /login for openai-codex again.",
  );
}

async function requestImage(
  url: string,
  headers: Headers,
  body: unknown,
  nativeResponses: boolean,
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
      return nativeResponses ? parseCodexSse(response, signal) : parseImageGenerationJson(response);
    }
    const text = await response.text();
    if (attempt === MAX_RETRIES || ![429, 500, 502, 503, 504].includes(response.status)) {
      throw new Error(`Codex image request failed (${response.status}): ${text.slice(0, 1000)}`);
    }
    const delay =
      parseRetryAfter(response.headers.get("retry-after")) ??
      Math.min(1000 * 2 ** attempt, MAX_DELAY_MS);
    await abortableDelay(delay, signal);
  }
  throw new Error("Codex image request failed after retries.");
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
      "Generate or edit an image through the active GPT 5.5+ provider's Responses endpoint and native gpt-image-2 hosted tool. Uses the active provider's endpoint and authentication, including custom providers such as agent-model, and supports up to five local or recent conversation reference images.",
    promptSnippet:
      "Generate or edit bitmap images through the active GPT provider's hosted image tool.",
    promptGuidelines: [
      "Use gpt_image when the user asks to generate or edit a raster image.",
      "Do not invoke gpt_image without a clear image request because it consumes the user's Codex image quota.",
    ],
    parameters,
    executionMode: "parallel",
    async execute(_toolCallId, params: GptImageParams, signal, onUpdate, ctx) {
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
      const format = params.outputFormat ?? "png";
      const headers = await buildRequestHeaders(model, () =>
        ctx.modelRegistry.getApiKeyAndHeaders(model),
      );
      const endpoint = resolveImageUrl(model);
      const nativeResponses = usesNativeResponses(model);
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
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Requesting ${images.length ? "image edit" : "image generation"} through ${provider}/${model.id}...`,
          },
        ],
        details: { provider, model: model.id, endpoint, format },
      });
      const requestBody = nativeResponses
        ? buildRequestBody(params, model.id, format, session, images)
        : buildImageGenerationsBody(params, model.id);
      const parsed = await requestImage(endpoint, headers, requestBody, nativeResponses, signal);
      if (!parsed.image) {
        const text = parsed.text.join("").trim();
        throw new Error(text ? `Codex returned no image: ${text}` : "Codex returned no image.");
      }
      const bytes = decodeImageData(parsed.image.result);
      const actualMimeType = magicMime(bytes) as string;
      const actualFormat: OutputFormat =
        actualMimeType === "image/jpeg" ? "jpeg" : actualMimeType === "image/webp" ? "webp" : "png";
      const directory = outputDirectory(session, agentDir);
      const extension = actualFormat === "jpeg" ? "jpg" : actualFormat;
      const savedPath = join(directory, imageFileName(parsed.image.id, extension));
      await withFileMutationQueue(savedPath, async () => {
        await mkdir(directory, { recursive: true });
        await writeFile(savedPath, bytes);
      });
      const mimeType = actualMimeType;
      return {
        content: [
          {
            type: "text",
            text: `Generated image via ${provider}/${model.id} using ${IMAGE_MODEL}. Saved to ${savedPath}.`,
          },
          { type: "image", data: parsed.image.result, mimeType },
        ],
        details: {
          provider,
          model: model.id,
          endpoint,
          backendImageModel: IMAGE_MODEL,
          outputFormat: actualFormat,
          requestedOutputFormat: format,
          savedPath,
          inputImageCount: images.length,
          responseId: parsed.responseId,
          imageGenerationId: parsed.image.id,
          revisedPrompt: parsed.image.revisedPrompt,
          usage: parsed.usage,
        },
      };
    },
  });
}
