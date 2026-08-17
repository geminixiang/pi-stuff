import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import extension, {
  abortableDelay,
  buildImageGenerationsBody,
  buildRequestBody,
  decodeImageData,
  imageFileName,
  parseCodexSse,
  parseImageGenerationJson,
  resolveImageUrl,
  resolveInputImages,
  resolveRoutingModel,
  usesNativeResponses,
} from "../extensions/index.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

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

function imageJson(image = PNG.toString("base64")) {
  return new Response(
    JSON.stringify({
      model: "gpt-5.6-sol",
      data: [{ b64_json: image }],
      usage: { total_tokens: 1 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function createTool(agentDir = join(tmpdir(), "pi-gpt-image-tests")) {
  let tool:
    | {
        execute: (...args: unknown[]) => Promise<{
          content: Array<{ type: string; data?: string }>;
          details: Record<string, unknown>;
        }>;
      }
    | undefined;
  extension(
    {
      registerTool(value: unknown) {
        tool = value as typeof tool;
      },
    } as never,
    agentDir,
  );
  assert.ok(tool);
  return tool;
}

function context(cwd: string, messages: unknown[] = []) {
  let authCalls = 0;
  return {
    cwd,
    isProjectTrusted: () => false,
    model: {
      provider: "agent-model",
      id: "gpt-5.6-sol",
      api: "openai-completions",
      baseUrl: "http://localhost:8080/v1",
    },
    modelRegistry: {
      find: (provider: string, id: string) => ({
        provider,
        id,
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      }),
      getApiKeyAndHeaders: async () => {
        authCalls++;
        return {
          ok: true as const,
          apiKey: jwt(),
          headers: { "x-refreshed-auth": "yes" },
        };
      },
      getApiKeyForProvider: async () => {
        throw new Error("provider-level raw token lookup must not be used");
      },
    },
    getAuthCalls: () => authCalls,
    sessionManager: {
      getSessionId: () => "../session:1",
      getBranch: () => messages.map((message) => ({ type: "message", message })),
    },
  };
}

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
    { prompt: "edit", referencedImagePaths: ["one.png", "two.jpg"] },
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

test("routing model follows eligible active GPT variants and otherwise falls back", () => {
  assert.equal(resolveRoutingModel(undefined, undefined, "gpt-5.5"), "gpt-5.5");
  assert.equal(resolveRoutingModel(undefined, undefined, "gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(resolveRoutingModel(undefined, undefined, "gpt-5.6-terra"), "gpt-5.6-terra");
  assert.equal(resolveRoutingModel(undefined, undefined, "gpt-5.6-luna"), "gpt-5.6-luna");
  assert.throws(
    () => resolveRoutingModel(undefined, undefined, "claude-opus-4-6"),
    /GPT 5\.5 or newer/,
  );
  assert.throws(() => resolveRoutingModel(undefined, undefined, "gpt-5.4"), /GPT 5\.5 or newer/);
  assert.equal(resolveRoutingModel(undefined, "gpt-5.6-terra", "gpt-5.6-sol"), "gpt-5.6-terra");
  assert.equal(resolveRoutingModel("gpt-5.6-luna", "gpt-5.5", "gpt-5.6-sol"), "gpt-5.6-luna");
});

test("provider API selects its real image endpoint and request contract", async () => {
  const gatewayModel = {
    provider: "agent-model",
    id: "gpt-5.6-sol",
    api: "openai-completions",
    baseUrl: "http://localhost:8080/v1",
  } as never;
  assert.equal(resolveImageUrl(gatewayModel), "http://localhost:8080/v1/images/generations");
  assert.equal(usesNativeResponses(gatewayModel), false);
  assert.deepEqual(buildImageGenerationsBody({ prompt: "draw" }, "gpt-5.6-sol"), {
    model: "gpt-5.6-sol",
    prompt: "draw",
    response_format: "b64_json",
    output_format: "png",
  });

  const codexModel = {
    provider: "openai-codex",
    id: "gpt-5.6-sol",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
  } as never;
  assert.equal(resolveImageUrl(codexModel), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(usesNativeResponses(codexModel), true);

  const parsed = await parseImageGenerationJson(
    new Response(
      JSON.stringify({
        model: "gpt-5.6-sol",
        data: [{ b64_json: PNG.toString("base64"), revised_prompt: "revised" }],
        usage: { total_tokens: 1 },
      }),
    ),
  );
  assert.equal(parsed.image?.result, PNG.toString("base64"));
  assert.equal(parsed.image?.revisedPrompt, "revised");
});

test("request uses configurable routing model and native gpt-image-2 options", () => {
  const body = buildRequestBody({ prompt: "draw" }, "gpt-5.5", "webp", "session");
  assert.equal(body.model, "gpt-5.5");
  assert.deepEqual(body.tools, [{ type: "image_generation", output_format: "webp" }]);
  assert.equal(body.tool_choice, "auto");
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

test("tool uses the active provider endpoint and refreshed provider auth", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "gpt-image-tool-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let request: RequestInit | undefined;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "http://localhost:8080/v1/images/generations");
    request = init;
    return imageJson();
  };
  const toolContext = context(cwd);
  const result = await createTool().execute(
    "call",
    { prompt: "draw" },
    undefined,
    undefined,
    toolContext,
  );
  const headers = new Headers(request?.headers);
  assert.match(String(headers.get("authorization")), /^Bearer /);
  assert.equal(headers.get("x-refreshed-auth"), "yes");
  assert.equal(toolContext.getAuthCalls(), 1);
  assert.equal(result.details.model, "gpt-5.6-sol");
  assert.equal(result.details.provider, "agent-model");
  assert.equal(result.content.find((part) => part.type === "image")?.data, PNG.toString("base64"));
});

test("tool follows an eligible active GPT model regardless of its provider label", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "gpt-image-active-model-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return imageJson();
  };
  const result = await createTool().execute("call", { prompt: "draw" }, undefined, undefined, {
    ...context(cwd),
    model: {
      provider: "custom-gpt-subscription",
      id: "gpt-5.6-sol",
      api: "openai-completions",
      baseUrl: "https://subscription.example/v1",
    },
  });
  assert.equal(body?.model, "gpt-5.6-sol");
  assert.equal(result.details.model, "gpt-5.6-sol");
});

test("normalized image providers ignore the recent-image placeholder for fresh generation", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "gpt-image-placeholder-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => imageJson();
  const result = await createTool().execute(
    "call",
    {
      prompt: "draw a cow",
      referencedImagePaths: [],
      numLastImagesToInclude: 1,
    },
    undefined,
    undefined,
    context(cwd),
  );
  assert.equal(result.details.inputImageCount, 0);
  assert.equal(result.content.find((part) => part.type === "image")?.data, PNG.toString("base64"));
});

test("missing image IDs receive unique UUID filenames", () => {
  const first = imageFileName(undefined, "png");
  const second = imageFileName(undefined, "png");
  assert.match(first, /^[0-9a-f-]{36}\.png$/);
  assert.notEqual(first, second);
  assert.equal(imageFileName("../../unsafe", "webp"), "unsafe.webp");
});
