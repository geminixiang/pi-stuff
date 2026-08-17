import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  getAgentDir,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-5.5";
const IMAGE_MODEL = "gpt-image-2";
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const AUTH_CLAIM = "https://api.openai.com/auth";
const MAX_IMAGES = 5;
const MAX_RETRIES = 3;
const MAX_DELAY_MS = 30_000;

const SAVE_MODES = ["none", "project", "global", "custom"] as const;
const OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;
type SaveMode = (typeof SAVE_MODES)[number];
type OutputFormat = (typeof OUTPUT_FORMATS)[number];
type ImageSize = (typeof IMAGE_SIZES)[number];

const parameters = Type.Object({
  prompt: Type.String({ description: "Detailed image generation or editing instructions." }),
  size: Type.Optional(StringEnum(IMAGE_SIZES, { description: "Requested output dimensions." })),
  outputFormat: Type.Optional(StringEnum(OUTPUT_FORMATS)),
  model: Type.Optional(
    Type.String({ description: `Codex routing model. Defaults to ${DEFAULT_MODEL}.` }),
  ),
  save: Type.Optional(StringEnum(SAVE_MODES)),
  saveDir: Type.Optional(
    Type.String({
      description: "Directory used with save=custom; relative paths resolve from the project.",
    }),
  ),
  referencedImagePaths: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_IMAGES })),
  numLastImagesToInclude: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_IMAGES })),
});
type GptImageParams = Static<typeof parameters>;

interface GptImageConfig {
  save?: SaveMode;
  saveDir?: string;
  model?: string;
}
interface InputImage {
  data: string;
  mimeType: string;
}
interface GeneratedImage {
  id: string;
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

function readConfig(path: string): GptImageConfig {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as GptImageConfig)
      : {};
  } catch {
    return {};
  }
}

export function loadConfig(
  cwd: string,
  trusted: boolean,
  agentDir = getAgentDir(),
): GptImageConfig {
  const global = readConfig(join(agentDir, "extensions", "gpt-image.json"));
  if (!trusted) return global;
  return { ...global, ...readConfig(join(cwd, ".pi", "extensions", "gpt-image.json")) };
}

export function resolveUnderCwd(cwd: string, value: string, home = homedir()): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return resolve(home, value.slice(2));
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
        const absolute = resolveUnderCwd(cwd, path.startsWith("@") ? path.slice(1) : path);
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

export function buildRequestBody(
  params: GptImageParams,
  model: string,
  format: OutputFormat,
  size: ImageSize,
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
    tools: [{ type: "image_generation", model: IMAGE_MODEL, size, output_format: format }],
    tool_choice: { type: "image_generation" },
    parallel_tool_calls: false,
    text: { verbosity: "low" },
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
        id: typeof item.id === "string" ? item.id : "image_generation",
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
  body: unknown,
  token: string,
  accountId: string,
  signal?: AbortSignal,
): Promise<ParsedResponse> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error("Image generation was aborted.");
    let response: Response;
    try {
      response = await fetch(RESPONSES_URL, {
        method: "POST",
        signal,
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${token}`,
          "chatgpt-account-id": accountId,
          originator: "pi",
          "OpenAI-Beta": "responses=experimental",
          accept: "text/event-stream",
          "content-type": "application/json",
        },
      });
    } catch (error) {
      if (signal?.aborted || attempt === MAX_RETRIES) throw error;
      await abortableDelay(Math.min(1000 * 2 ** attempt, MAX_DELAY_MS), signal);
      continue;
    }
    if (response.ok) return parseCodexSse(response, signal);
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

function outputDirectory(
  mode: SaveMode,
  cwd: string,
  session: string,
  custom?: string,
): string | undefined {
  if (mode === "none") return undefined;
  if (mode === "project") return join(cwd, ".pi", "generated-images", session);
  if (mode === "global") return join(getAgentDir(), "generated-images", session);
  if (!custom?.trim()) throw new Error("save=custom requires saveDir or PI_GPT_IMAGE_SAVE_DIR.");
  return join(resolveUnderCwd(cwd, custom), session);
}

export default function gptImageExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "gpt_image",
    label: "GPT Image",
    description:
      "Generate or edit an image with gpt-image-2 through Pi's existing openai-codex OAuth login. Supports up to five local or recent conversation reference images.",
    promptSnippet: "Generate or edit bitmap images with the Codex native gpt-image-2 tool.",
    promptGuidelines: [
      "Use gpt_image when the user asks to generate or edit a raster image.",
      "Do not invoke gpt_image without a clear image request because it consumes the user's Codex image quota.",
    ],
    parameters,
    executionMode: "parallel",
    async execute(toolCallId, params: GptImageParams, signal, onUpdate, ctx) {
      const trusted = typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
      const config = loadConfig(ctx.cwd, trusted);
      const model = params.model || config.model || DEFAULT_MODEL;
      const format = params.outputFormat ?? "png";
      const size = params.size ?? "1024x1024";
      const requestedMode = (params.save ||
        process.env.PI_GPT_IMAGE_SAVE_MODE?.toLowerCase() ||
        config.save ||
        "global") as SaveMode;
      if (!SAVE_MODES.includes(requestedMode))
        throw new Error(`Invalid save mode: ${requestedMode}.`);
      const token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
      if (!token)
        throw new Error(
          "Missing openai-codex credentials. Run /login and select ChatGPT Plus/Pro (Codex).",
        );
      const accountId = decodeJwtAccountId(token);
      const session = sanitizePathPart(ctx.sessionManager.getSessionId(), "session");
      const messages: unknown[] = [];
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "message") messages.push(entry.message);
        else if (entry.type === "custom_message") messages.push(entry);
      }
      const images = await resolveInputImages(params, ctx.cwd, messages);
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Requesting ${size} ${images.length ? "edit" : "image"} through ${PROVIDER}/${model}...`,
          },
        ],
        details: { model, size, format },
      });
      const parsed = await requestImage(
        buildRequestBody(params, model, format, size, session, images),
        token,
        accountId,
        signal,
      );
      if (!parsed.image) {
        const text = parsed.text.join("").trim();
        throw new Error(text ? `Codex returned no image: ${text}` : "Codex returned no image.");
      }
      const bytes = decodeImageData(parsed.image.result, format);
      const custom = params.saveDir || process.env.PI_GPT_IMAGE_SAVE_DIR || config.saveDir;
      const directory = outputDirectory(requestedMode, ctx.cwd, session, custom);
      const extension = format === "jpeg" ? "jpg" : format;
      let savedPath: string | undefined;
      let attemptedPath: string | undefined;
      let saveWarning: string | undefined;
      if (directory) {
        attemptedPath = join(
          directory,
          `${sanitizePathPart(parsed.image.id || toolCallId, "image_generation")}.${extension}`,
        );
        try {
          await withFileMutationQueue(attemptedPath, async () => {
            await mkdir(directory, { recursive: true });
            await writeFile(attemptedPath as string, bytes);
          });
          savedPath = attemptedPath;
        } catch (error) {
          saveWarning = `Image generation succeeded, but disk persistence failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const mimeType = format === "jpeg" ? "image/jpeg" : `image/${format}`;
      return {
        content: [
          {
            type: "text",
            text: [
              `Generated ${size} image via ${PROVIDER}/${model} using ${IMAGE_MODEL}.`,
              savedPath ? `Saved to ${savedPath}.` : "Image was not saved to disk.",
              saveWarning ? `Warning: ${saveWarning}` : undefined,
            ]
              .filter(Boolean)
              .join(" "),
          },
          { type: "image", data: parsed.image.result, mimeType },
        ],
        details: {
          provider: PROVIDER,
          model,
          backendImageModel: IMAGE_MODEL,
          size,
          outputFormat: format,
          saveMode: requestedMode,
          savedPath,
          attemptedPath,
          saveWarning,
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
