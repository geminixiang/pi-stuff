import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import test, { type TestContext } from "node:test";
import {
  createProvider,
  createAssistantMessageEventStream,
  type Model,
  type ProviderStreams,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const image = {
  type: "image_generation_call",
  id: "image-1",
  status: "completed",
  result: PNG,
  revised_prompt: "牛 🐄",
};
const terminal = {
  type: "response.completed",
  response: {
    id: "response-1",
    status: "completed",
    output: [image],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  },
};
function response(
  events: unknown[] = [
    { type: "response.created", response: { id: "response-1" } },
    { type: "response.output_item.done", output_index: 0, item: image },
    terminal,
  ],
  lineEnd = "\r\n",
) {
  const bytes = Buffer.from(
    events
      .map((event) => `event: message${lineEnd}data: ${JSON.stringify(event)}${lineEnd}${lineEnd}`)
      .join(""),
  );
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Every UTF-8 byte and CR/LF boundary is split, exercising the public adapter's parser.
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function body(init?: RequestInit) {
  const headers = new Headers(init?.headers);
  return JSON.parse(
    headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(init?.body as Uint8Array).toString()
      : String(init?.body),
  );
}
async function setup(t: TestContext, api = "openai-responses", streams?: ProviderStreams) {
  const dir = await mkdtemp(join(tmpdir(), "gpt-image-native-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"),
    authPath: join(dir, "auth.json"),
    refreshOnCreate: false,
  });
  const model: Model<any> = {
    provider: "image-test",
    id: "gpt-5.5",
    api,
    baseUrl: "https://catalog.invalid/v1",
    name: "GPT test",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128000,
    maxTokens: 4096,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    headers: { "x-model-header": "present", "x-remove": "remove-me" },
  };
  let authCalls = 0;
  runtime.registerNativeProvider(
    createProvider({
      id: model.provider,
      models: [model, { ...model, id: "gpt-5.6-luna" }],
      auth: {
        apiKey: {
          name: "test",
          resolve: async () => {
            authCalls++;
            return {
              auth: {
                apiKey:
                  api === "openai-codex-responses" || api === "cliproxyapi-codex-responses"
                    ? `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64")}.signature`
                    : "request-time-key",
                baseUrl: "https://resolved.invalid/v1",
                headers: { "x-auth-header": "refreshed", "x-remove": null },
              },
              env: {
                AZURE_OPENAI_BASE_URL: "https://test.openai.azure.com",
                AZURE_OPENAI_API_VERSION: "test-version",
                AZURE_OPENAI_DEPLOYMENT_NAME_MAP:
                  "gpt-5.5=deployment-55,gpt-5.6-luna=deployment-luna",
              },
            };
          },
        },
      },
      api:
        streams ??
        (api === "openai-codex-responses"
          ? openAICodexResponsesApi()
          : api === "azure-openai-responses"
            ? azureOpenAIResponsesApi()
            : openAIResponsesApi()),
    }),
  );
  const registry = new ModelRegistry(runtime);
  registry.getApiKeyAndHeaders = async () => {
    throw new Error("native path must use request-time SDK auth");
  };
  const originalStream = registry.streamSimple.bind(registry);
  let normalized: AssistantMessage | undefined;
  registry.streamSimple = (model, context, options) => {
    assert.equal(options?.transport, "sse");
    assert.equal(options?.maxRetries, 3);
    assert.equal(options?.maxRetryDelayMs, 30_000);
    const stream = originalStream(model, context, options);
    void stream.result().then((result) => {
      normalized = result;
    });
    return stream;
  };
  let execute!: (
    id: string,
    params: unknown,
    signal: AbortSignal | undefined,
    update: undefined,
    ctx: unknown,
  ) => Promise<any>;
  extension(
    {
      registerTool(tool: { execute: typeof execute }) {
        execute = tool.execute;
      },
    } as never,
    dir,
  );
  const ctx = {
    cwd: dir,
    model,
    modelRegistry: registry,
    sessionManager: {
      getSessionId: () => "session",
      getBranch: () => [
        { type: "custom_message", content: [{ type: "image", data: PNG, mimeType: "image/png" }] },
      ],
    },
  };
  return {
    dir,
    execute: (params: unknown = { prompt: "draw" }, signal?: AbortSignal) =>
      execute("call", params, signal, undefined, ctx),
    authCalls: () => authCalls,
    normalized: () => normalized,
  };
}

for (const api of ["openai-responses", "azure-openai-responses", "openai-codex-responses"]) {
  test(`public ModelRegistry native pipeline: ${api}, image-only completion and deduplication`, async (t) => {
    const fixture = await setup(t, api);
    let requestBody: any;
    globalThis.fetch = async (url, init) => {
      const endpoint = String(url);
      if (api === "azure-openai-responses") {
        assert.equal(
          endpoint,
          "https://test.openai.azure.com/openai/v1/responses?api-version=test-version",
        );
        assert.equal(new Headers(init?.headers).get("api-key"), "request-time-key");
      } else {
        assert.equal(
          endpoint,
          api === "openai-codex-responses"
            ? "https://resolved.invalid/v1/codex/responses"
            : "https://resolved.invalid/v1/responses",
        );
        assert.match(new Headers(init?.headers).get("authorization")!, /^Bearer /);
      }
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-auth-header"), "refreshed");
      assert.equal(headers.get("x-model-header"), "present");
      // Pi 1.0.4 drops auth nulls before the adapter remerges model headers.
      assert.equal(headers.get("x-remove"), "remove-me");
      requestBody = body(init);
      // Pi 1.0.4 Codex has its own LF-only SSE parser; SDK-backed adapters support CRLF.
      return response(undefined, api === "openai-codex-responses" ? "\n" : "\r\n");
    };
    const result = await fixture.execute({ prompt: "draw 牛 🐄", model: "gpt-5.6-luna" });
    assert.equal(
      requestBody.model,
      api === "azure-openai-responses" ? "deployment-luna" : "gpt-5.6-luna",
    );
    assert.deepEqual(requestBody.input[0].content, [{ type: "input_text", text: "draw 牛 🐄" }]);
    assert.deepEqual(requestBody.tools, [{ type: "image_generation", output_format: "png" }]);
    assert.equal(requestBody.store, false);
    assert.equal(requestBody.stream, true);
    assert.equal(requestBody.parallel_tool_calls, false);
    assert.ok(fixture.authCalls() >= 1);
    assert.deepEqual(fixture.normalized()?.content, []);
    assert.equal(fixture.normalized()?.stopReason, "stop");
    assert.equal(fixture.normalized()?.usage.totalTokens, 12);
    assert.equal(result.details.responseId, "response-1");
    assert.equal(result.details.revisedPrompt, "牛 🐄");
    assert.equal(result.details.backendImageModel, undefined);
    assert.deepEqual(result.details.usage, terminal.response.usage);
    assert.equal(result.content.filter((part: any) => part.type === "image").length, 1);
    assert.deepEqual(await readFile(result.details.savedPath), Buffer.from(PNG, "base64"));
    assert.deepEqual(await readdir(join(fixture.dir, "generated-images", "session")), [
      "image-1.png",
    ]);
  });
}

test("CLIProxyAPI custom Responses API uses its registered transport, not image generations", async (t) => {
  const adapter = openAICodexResponsesApi();
  let calls = 0;
  const fixture = await setup(t, "cliproxyapi-codex-responses", {
    ...adapter,
    streamSimple(model, context, options) {
      calls++;
      return adapter.streamSimple(model, context, options);
    },
  });
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://resolved.invalid/v1/codex/responses");
    assert.deepEqual(body(init).tools, [{ type: "image_generation", output_format: "png" }]);
    return response(undefined, "\n");
  };
  const result = await fixture.execute();
  assert.equal(calls, 1);
  assert.equal(result.details.responseId, "response-1");
  assert.deepEqual(await readFile(result.details.savedPath), Buffer.from(PNG, "base64"));
});

test("native terminal-only output supports local and recent references without truncating inputs", async (t) => {
  const fixture = await setup(t);
  await writeFile(join(fixture.dir, "reference.png"), Buffer.from(PNG, "base64"));
  const prompt = "full prompt 牛 🐄 ".repeat(1000);
  globalThis.fetch = async (_url, init) => {
    const payload = body(init);
    assert.deepEqual(payload.input[0].content, [
      { type: "input_text", text: prompt },
      { type: "input_image", image_url: `data:image/png;base64,${PNG}` },
    ]);
    assert.deepEqual(payload.tools, [{ type: "image_generation", output_format: "webp" }]);
    return response([terminal]);
  };
  for (const references of [
    { referencedImagePaths: ["reference.png"] },
    { numLastImagesToInclude: 1 },
  ]) {
    const result = await fixture.execute({ prompt, outputFormat: "webp", ...references });
    assert.equal(result.details.inputImageCount, 1);
    assert.equal(result.details.requestedOutputFormat, "webp");
    assert.equal(result.details.outputFormat, "png");
  }
});

for (const [name, events, expected] of [
  ["missing image", [{ ...terminal, response: { ...terminal.response, output: [] } }], /no image/],
  [
    "missing terminal",
    [{ type: "response.output_item.done", output_index: 0, item: image }],
    /terminal response/,
  ],
  [
    "failed",
    [
      {
        type: "response.failed",
        response: { status: "failed", error: { message: "quota failure" } },
      },
    ],
    /quota failure/,
  ],
  ["error", [{ type: "error", code: "bad_request", message: "bad prompt" }], /bad prompt/],
  [
    "incomplete",
    [
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [image],
        },
      },
    ],
    /successful completed response/,
  ],
  [
    "image failed",
    [
      { type: "response.output_item.done", output_index: 0, item: { ...image, status: "failed" } },
      terminal,
    ],
    /status: failed/,
  ],
  [
    "missing image status",
    [
      {
        ...terminal,
        response: { ...terminal.response, output: [{ ...image, status: undefined }] },
      },
    ],
    /status: undefined/,
  ],
  [
    "conflicting images",
    [
      { type: "response.output_item.done", output_index: 0, item: image },
      { ...terminal, response: { ...terminal.response, output: [{ ...image, id: "other" }] } },
    ],
    /multiple or conflicting/,
  ],
  [
    "invalid base64",
    [{ ...terminal, response: { ...terminal.response, output: [{ ...image, result: "!!!!" }] } }],
    /invalid base64/,
  ],
] as const) {
  test(`native rejects ${name} and writes nothing`, async (t) => {
    const fixture = await setup(t);
    globalThis.fetch = async () => response([...events]);
    await assert.rejects(fixture.execute(), expected);
    await assert.rejects(readdir(join(fixture.dir, "generated-images")), /ENOENT/);
  });
}

test("native HTTP errors and oversized Retry-After surface instead of silent success", async (t) => {
  const fixture = await setup(t);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "invalid request" } }), { status: 400 });
  await assert.rejects(fixture.execute(), /invalid request/);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("rate limit", { status: 429, headers: { "retry-after": "60" } });
  };
  await assert.rejects(fixture.execute(), /Server requested 60s retry delay/);
  assert.equal(calls, 1);
});

test("native cancellation aborts pending transport and prevents saving", async (t) => {
  const fixture = await setup(t);
  const controller = new AbortController();
  globalThis.fetch = async (_url, init) => {
    controller.abort();
    init?.signal?.throwIfAborted();
    throw new Error("should not reach");
  };
  await assert.rejects(fixture.execute(undefined, controller.signal), /aborted/);
  await assert.rejects(readdir(join(fixture.dir, "generated-images")), /ENOENT/);
});

test("custom Responses provider omitting instrumentation fails clearly", async (t) => {
  const unsupported: ProviderStreams = {
    stream: () => {
      throw new Error("not used");
    },
    streamSimple: (model) => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
      stream.end();
      return stream;
    },
  };
  const fixture = await setup(t, "openai-responses", unsupported);
  await assert.rejects(
    fixture.execute(),
    /must support onPayload replacement and onProviderStreamEvent/,
  );
});

test("native cancellation while consuming SSE cancels the stream and writes nothing", async (t) => {
  const fixture = await setup(t);
  const controller = new AbortController();
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(stream) {
          stream.enqueue(
            Buffer.from(
              `data: ${JSON.stringify({ type: "response.created", response: { id: "pending" } })}\n\n`,
            ),
          );
          setTimeout(() => controller.abort(), 10);
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  await assert.rejects(fixture.execute(undefined, controller.signal), /aborted/);
  await assert.rejects(readdir(join(fixture.dir, "generated-images")), /ENOENT/);
});

test("native SDK retries a transient request, but not a failed response stream", async (t) => {
  const fixture = await setup(t);
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1
      ? new Response("rate limit", { status: 429, headers: { "retry-after-ms": "1" } })
      : response([terminal]);
  await fixture.execute();
  assert.equal(calls, 2);
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response([
      { type: "response.failed", response: { error: { message: "stream failure" } } },
    ]);
  };
  await assert.rejects(fixture.execute(), /stream failure/);
  assert.equal(calls, 1);
});

test("Pi 1.0.4 Codex CRLF limitation fails explicitly", async (t) => {
  const fixture = await setup(t, "openai-codex-responses");
  globalThis.fetch = async () => response();
  await assert.rejects(fixture.execute(), /Invalid Codex SSE JSON/);
});

test("native missing image IDs remain undefined and save with unique UUID filenames", async (t) => {
  const fixture = await setup(t);
  const withoutId = { ...image, id: undefined };
  globalThis.fetch = async () =>
    response([
      { type: "response.output_item.done", output_index: 0, item: withoutId },
      { ...terminal, response: { ...terminal.response, output: [withoutId] } },
    ]);
  const first = await fixture.execute();
  const second = await fixture.execute();
  assert.equal(first.details.imageGenerationId, undefined);
  assert.notEqual(first.details.savedPath, second.details.savedPath);
  assert.equal((await readdir(join(fixture.dir, "generated-images", "session"))).length, 2);
});
