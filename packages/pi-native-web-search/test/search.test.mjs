import assert from "node:assert/strict";
import test from "node:test";

import {
	buildAnthropicHeaders,
	decodeJwtAccountId,
	extractEventData,
	getCachedOAuthAccess,
	normalizeProvider,
	parseArgs,
	parseExpiryTimestamp,
	parseResponsesText,
	pickFastModel,
	pickProvider,
	resolveAgentModel,
	resolveCodexUrl,
	resolveConfigValue,
	resolveResponsesUrl,
} from "../skills/native-web-search/search.mjs";

test("parseArgs parses positional query and options", () => {
	assert.deepEqual(parseArgs(["latest", "Node.js", "--purpose", "upgrade", "--timeout=500", "--json"]), {
		provider: undefined,
		model: undefined,
		purpose: "upgrade",
		timeoutMs: 1000,
		json: true,
		help: false,
		query: "latest Node.js",
	});
});

test("provider normalization and selection follow explicit, settings, then auth order", () => {
	assert.equal(normalizeProvider("Claude"), "anthropic");
	assert.equal(normalizeProvider("openai"), "openai-codex");
	assert.equal(normalizeProvider("agent-model"), "agent-model");
	assert.equal(pickProvider(undefined, "agent-model", { defaultProvider: "openai-codex" }, {}), "agent-model");
	assert.equal(pickProvider("anthropic", "agent-model", { defaultProvider: "openai-codex" }, {}), "anthropic");
	assert.equal(pickProvider(undefined, "codex", { defaultProvider: "anthropic" }, {}), "openai-codex");
	assert.equal(pickProvider(undefined, undefined, { defaultProvider: "codex" }, { anthropic: {} }), "openai-codex");
	assert.equal(pickProvider(undefined, undefined, {}, { anthropic: {} }), "anthropic");
});

test("unsupported active provider never falls back to unrelated credentials", () => {
	assert.throws(
		() => pickProvider(undefined, "custom-gateway", {}, { "openai-codex": {} }),
		/Active provider 'custom-gateway'.*refusing to fall back/,
	);
	assert.throws(
		() => pickProvider(undefined, undefined, { defaultProvider: "custom-gateway" }, { "openai-codex": {} }),
		/Default provider 'custom-gateway'.*refusing to fall back/,
	);
	assert.throws(() => pickProvider("custom-gateway", undefined, {}, {}), /Unsupported provider/);
});

test("agent-model resolves active model, gateway URL, and $ENV API key", () => {
	const previous = process.env.TEST_AGENT_MODEL_TOKEN;
	process.env.TEST_AGENT_MODEL_TOKEN = "gateway-token";
	try {
		const model = resolveAgentModel(
			{},
			{
				providers: {
					"agent-model": {
						baseUrl: "http://localhost:8080/v1",
						apiKey: "$TEST_AGENT_MODEL_TOKEN",
						models: [{ id: "gpt-5.6-sol" }],
					},
				},
			},
			"gpt-5.6-sol",
		);
		assert.deepEqual(model, {
			id: "gpt-5.6-sol",
			baseUrl: "http://localhost:8080/v1",
			apiKey: "gateway-token",
		});
		assert.equal(resolveResponsesUrl(model.baseUrl), "http://localhost:8080/v1/responses");
		assert.equal(resolveConfigValue("$TEST_AGENT_MODEL_TOKEN"), "gateway-token");
	} finally {
		if (previous === undefined) delete process.env.TEST_AGENT_MODEL_TOKEN;
		else process.env.TEST_AGENT_MODEL_TOKEN = previous;
	}
});

test("Responses parser handles CRLF and chunk boundaries", async () => {
	const source = [
		'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"hello "}\r\n\r\n',
		'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"world"}\r\n\r\n',
		'event: response.completed\r\ndata: {"type":"response.completed","response":{}}\r\n\r\n',
	].join("");
	const stream = new ReadableStream({
		start(controller) {
			for (let index = 0; index < source.length; index += 5) controller.enqueue(Buffer.from(source.slice(index, index + 5)));
			controller.close();
		},
	});
	assert.equal(await parseResponsesText(new Response(stream), "test"), "hello world");
});

test("OAuth cache accepts only unexpired access tokens", () => {
	const now = Date.UTC(2026, 0, 1);
	assert.equal(parseExpiryTimestamp(String((now + 60_000) / 1000)), now + 60_000);
	assert.deepEqual(getCachedOAuthAccess({ access: "token", expires: now + 60_000, accountId: "acct" }, now), {
		apiKey: "token",
		accountId: "acct",
	});
	assert.equal(getCachedOAuthAccess({ access: "token", expires: now + 20_000 }, now), undefined);
});

test("JWT account ID decoding is defensive", () => {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString(
		"base64url",
	);
	assert.equal(decodeJwtAccountId(`header.${payload}.sig`), "acct");
	assert.equal(decodeJwtAccountId("invalid"), undefined);
});

test("model selection prefers fast known models", () => {
	const piAi = {
		getModels: () => [
			{ id: "gpt-5.1", baseUrl: "slow" },
			{ id: "gpt-5.1-codex-mini", baseUrl: "fast" },
		],
	};
	assert.equal(pickFastModel("openai-codex", undefined, piAi).baseUrl, "fast");
	assert.equal(pickFastModel("openai-codex", "custom", piAi).id, "custom");
});

test("request helpers construct endpoints, headers, and parse SSE data", () => {
	assert.equal(resolveCodexUrl("https://example.com/backend-api/"), "https://example.com/backend-api/codex/responses");
	assert.equal(extractEventData('event: message\ndata: {"type":"done"}\n'), '{"type":"done"}');
	assert.equal(extractEventData("data: [DONE]"), null);
	assert.equal(buildAnthropicHeaders("sk-ant-oat-example").authorization, "Bearer sk-ant-oat-example");
	assert.equal(buildAnthropicHeaders("sk-ant-example")["x-api-key"], "sk-ant-example");
});
