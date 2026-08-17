import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import extension, {
  abortableDelay,
  buildRequestBody,
  decodeImageData,
  loadConfig,
  parseCodexSse,
  resolveInputImages,
  sanitizePathPart,
} from "../extensions/index.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

function jwt() {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function sse(image = PNG.toString("base64"), lineEnd = "\n") {
  const events = [
    { type: "response.created", response: { id: "response-1" } },
    {
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        id: "../../unsafe",
        status: "completed",
        result: image,
      },
    },
    { type: "response.completed", response: { id: "response-1", usage: { total_tokens: 1 } } },
  ];
  return new Response(
    events
      .map((event) => `event: message${lineEnd}data: ${JSON.stringify(event)}${lineEnd}${lineEnd}`)
      .join(""),
  );
}

function createTool() {
  let tool:
    | {
        execute: (...args: unknown[]) => Promise<{
          content: Array<{ type: string; data?: string }>;
          details: Record<string, unknown>;
        }>;
      }
    | undefined;
  extension({
    registerTool(value: unknown) {
      tool = value as typeof tool;
    },
  } as never);
  assert.ok(tool);
  return tool;
}

function context(cwd: string, messages: unknown[] = []) {
  return {
    cwd,
    isProjectTrusted: () => false,
    modelRegistry: { getApiKeyForProvider: async () => jwt() },
    sessionManager: {
      getSessionId: () => "../session:1",
      getBranch: () => messages.map((message) => ({ type: "message", message })),
    },
  };
}

test("project configuration overlays global configuration only when trusted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gpt-image-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(join(root, "agent/extensions/gpt-image.json"), {
    save: "global",
    model: "global-model",
  });
  await writeJson(join(root, "project/.pi/extensions/gpt-image.json"), {
    save: "none",
    model: "project-model",
  });
  assert.deepEqual(loadConfig(join(root, "project"), false, join(root, "agent")), {
    save: "global",
    model: "global-model",
  });
  assert.deepEqual(loadConfig(join(root, "project"), true, join(root, "agent")), {
    save: "none",
    model: "project-model",
  });
});

test("strict decoding validates base64 and requested magic bytes", () => {
  assert.deepEqual(decodeImageData(PNG.toString("base64"), "png"), PNG);
  assert.deepEqual(decodeImageData(JPEG.toString("base64"), "jpeg"), JPEG);
  for (const value of ["", "!!!!", "aGVsbG8"])
    assert.throws(() => decodeImageData(value, "png"), /invalid base64/);
  assert.throws(() => decodeImageData(JPEG.toString("base64"), "png"), /does not match png/);
});

test("input selectors are exclusive and local images preserve order", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "gpt-image-input-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "one.png"), PNG);
  await writeFile(join(cwd, "two.jpg"), JPEG);
  const images = await resolveInputImages(
    { prompt: "edit", referencedImagePaths: ["one.png", "@two.jpg"] },
    cwd,
    [],
  );
  assert.deepEqual(
    images.map((image) => image.mimeType),
    ["image/png", "image/jpeg"],
  );
  await assert.rejects(
    resolveInputImages(
      { prompt: "x", referencedImagePaths: ["one.png"], numLastImagesToInclude: 1 },
      cwd,
      [],
    ),
    /either/,
  );
});

test("request uses configurable routing model and native gpt-image-2 options", () => {
  const body = buildRequestBody({ prompt: "draw" }, "gpt-5.5", "webp", "1024x1536", "session");
  assert.equal(body.model, "gpt-5.5");
  assert.deepEqual(body.tools, [
    { type: "image_generation", model: "gpt-image-2", size: "1024x1536", output_format: "webp" },
  ]);
  assert.deepEqual(body.tool_choice, { type: "image_generation" });
});

test("SSE parser handles CRLF and chunk boundaries", async () => {
  const source = await sse(PNG.toString("base64"), "\r\n").text();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < source.length; index += 7)
        controller.enqueue(Buffer.from(source.slice(index, index + 7)));
      controller.close();
    },
  });
  const parsed = await parseCodexSse(new Response(stream));
  assert.equal(parsed.image?.result, PNG.toString("base64"));
  assert.equal(parsed.responseId, "response-1");
});

test("abortable backoff exits promptly", async () => {
  const controller = new AbortController();
  const pending = abortableDelay(10_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
});

test("tool works under any active provider and sends Codex OAuth request", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "gpt-image-tool-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let request: RequestInit | undefined;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
    request = init;
    return sse();
  };
  const result = await createTool().execute(
    "call",
    { prompt: "draw", save: "none" },
    undefined,
    undefined,
    {
      ...context(cwd),
      model: { provider: "anthropic", id: "claude" },
    },
  );
  assert.match(String(new Headers(request?.headers).get("authorization")), /^Bearer /);
  assert.equal(result.details.model, "gpt-5.5");
  assert.equal(result.content.find((part) => part.type === "image")?.data, PNG.toString("base64"));
});

test("disk failure retains inline image and sanitized attempted path", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "gpt-image-save-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const blocker = join(cwd, "blocker");
  await writeFile(blocker, "file");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => sse();
  const result = await createTool().execute(
    "call",
    { prompt: "draw", save: "custom", saveDir: blocker },
    undefined,
    undefined,
    context(cwd),
  );
  assert.match(String(result.details.saveWarning), /persistence failed/);
  assert.doesNotMatch(String(result.details.attemptedPath), /\.\.\/unsafe/);
  assert.equal(result.content.find((part) => part.type === "image")?.data, PNG.toString("base64"));
  assert.equal(sanitizePathPart("../../unsafe", "fallback"), "unsafe");
  await assert.rejects(readFile(String(result.details.attemptedPath)));
});
