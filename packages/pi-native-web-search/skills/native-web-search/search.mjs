#!/usr/bin/env node

// Derived from mitsuhiko/agent-stuff's native-web-search skill (Apache-2.0).
// Modified for @earendil-works/pi-ai compatibility and active-provider safety.

import { existsSync, readFileSync, writeFileSync, realpathSync } from "fs";
import { spawnSync, execSync } from "child_process";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

function parseArgs(argv) {
	const out = {
		provider: undefined,
		model: undefined,
		purpose: "general research support",
		timeoutMs: 120000,
		json: false,
		help: false,
		query: "",
	};

	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			out.help = true;
			continue;
		}
		if (arg === "--json") {
			out.json = true;
			continue;
		}
		if (arg === "--provider") {
			out.provider = argv[++i];
			continue;
		}
		if (arg.startsWith("--provider=")) {
			out.provider = arg.slice("--provider=".length);
			continue;
		}
		if (arg === "--model") {
			out.model = argv[++i];
			continue;
		}
		if (arg.startsWith("--model=")) {
			out.model = arg.slice("--model=".length);
			continue;
		}
		if (arg === "--purpose") {
			out.purpose = argv[++i] || out.purpose;
			continue;
		}
		if (arg.startsWith("--purpose=")) {
			out.purpose = arg.slice("--purpose=".length) || out.purpose;
			continue;
		}
		if (arg === "--timeout") {
			out.timeoutMs = Math.max(1000, Number(argv[++i] || out.timeoutMs));
			continue;
		}
		if (arg.startsWith("--timeout=")) {
			out.timeoutMs = Math.max(1000, Number(arg.slice("--timeout=".length) || out.timeoutMs));
			continue;
		}
		positional.push(arg);
	}

	out.query = positional.join(" ").trim();
	return out;
}

function usage() {
	return `Usage:
  node search.mjs "<query>" [--purpose "<why>"] [--provider agent-model|openai-codex|anthropic] [--model <id>] [--json]

Examples:
  node search.mjs "latest python release" --purpose "update dependency notes"
  node search.mjs "HTTP/3 browser support 2026" --provider openai-codex
  node search.mjs "vite 7 breaking changes" --json`;
}

function readJson(path, fallback = {}) {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveConfigValue(config) {
	if (typeof config !== "string" || !config) return undefined;
	if (config.startsWith("!")) {
		try {
			const out = execSync(config.slice(1), {
				encoding: "utf8",
				timeout: 10000,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			return out || undefined;
		} catch {
			return undefined;
		}
	}
	if (config.startsWith("$")) return process.env[config.slice(1)];
	return process.env[config] || config;
}

function getAgentDir() {
	const configured = process.env.PI_CODING_AGENT_DIR;
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return configured;
}

function normalizeProvider(provider) {
	if (!provider) return undefined;
	const p = String(provider).toLowerCase().trim();
	if (p === "agent-model" || p === "agentmodel") return "agent-model";
	if (p.includes("anthropic") || p.includes("claude")) return "anthropic";
	if (p.includes("codex") || p === "openai" || p.startsWith("openai")) return "openai-codex";
	return undefined;
}

function pickProvider(argProvider, activeProvider, settings, auth) {
	if (argProvider) {
		const forced = normalizeProvider(argProvider);
		if (!forced) {
			throw new Error(`Unsupported provider '${argProvider}'. Pass --provider agent-model|openai-codex|anthropic`);
		}
		return forced;
	}

	if (activeProvider) {
		const active = normalizeProvider(activeProvider);
		if (active) return active;
		throw new Error(
			`Active provider '${activeProvider}' does not expose a supported native web-search transport. ` +
				"Pass --provider agent-model|openai-codex|anthropic explicitly; refusing to fall back to unrelated credentials.",
		);
	}

	if (settings?.defaultProvider) {
		const configured = normalizeProvider(settings.defaultProvider);
		if (configured) return configured;
		throw new Error(
			`Default provider '${settings.defaultProvider}' does not expose a supported native web-search transport. ` +
				"Pass --provider agent-model|openai-codex|anthropic explicitly; refusing to fall back to unrelated credentials.",
		);
	}

	if (auth?.["openai-codex"]) return "openai-codex";
	if (auth?.anthropic) return "anthropic";

	throw new Error("Could not determine provider. Pass --provider agent-model|openai-codex|anthropic");
}

function decodeJwtAccountId(jwt) {
	if (!jwt || typeof jwt !== "string") return undefined;
	try {
		const parts = jwt.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
	} catch {
		return undefined;
	}
}

function findPiExecutable() {
	const cmd = process.platform === "win32" ? "where" : "which";
	const result = spawnSync(cmd, ["pi"], { encoding: "utf8" });
	if (result.status !== 0) return undefined;
	const first = result.stdout
		.split(/\r?\n/)
		.map((x) => x.trim())
		.find(Boolean);
	return first || undefined;
}

function collectModuleCandidates(fileName = "index.js", envVarName = "PI_AI_MODULE_PATH") {
	const candidates = new Set();

	const add = (p) => {
		if (!p) return;
		const abs = isAbsolute(p) ? p : resolve(p);
		candidates.add(abs);
	};

	if (envVarName && process.env[envVarName]) add(process.env[envVarName]);

	const cwd = process.cwd();
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	for (const start of [cwd, scriptDir]) {
		let dir = start;
		for (let i = 0; i < 8; i++) {
			for (const scope of ["@earendil-works", "@mariozechner"]) {
			add(join(dir, "node_modules", scope, "pi-ai", "dist", fileName));
		}
			add(join(dir, "packages", "ai", "dist", fileName));
			add(join(dir, "ai", "dist", fileName));
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}

	const piExec = findPiExecutable();
	if (piExec) {
		try {
			const piReal = realpathSync(piExec);
			const piDir = dirname(piReal);
			add(join(piDir, "..", "..", "ai", "dist", fileName));
			add(join(piDir, "..", "..", "pi-ai", "dist", fileName));
			for (const scope of ["@earendil-works", "@mariozechner"]) {
				add(join(piDir, "..", "node_modules", scope, "pi-ai", "dist", fileName));
				add(join(piDir, "..", "..", "node_modules", scope, "pi-ai", "dist", fileName));
			}
		} catch {
			// ignore
		}
	}

	add(join(homedir(), "Development", "pi-mono", "packages", "ai", "dist", fileName));

	return Array.from(candidates);
}

async function importPiAiSubpath(subpath = "") {
	const packages = ["@earendil-works/pi-ai", "@mariozechner/pi-ai"];
	const tried = [];
	for (const packageName of packages) {
		const specifier = `${packageName}${subpath}`;
		try {
			return { module: await import(specifier), tried };
		} catch (err) {
			tried.push(`${specifier} (${err?.code || err?.message || "not found"})`);
		}
	}
	return { module: undefined, tried };
}

async function loadPiAi() {
	const imported = await importPiAiSubpath();
	if (imported.module) return imported.module;
	const tried = [...imported.tried];

	for (const candidate of collectModuleCandidates("index.js", "PI_AI_MODULE_PATH")) {
		if (!existsSync(candidate)) continue;
		try {
			return await import(pathToFileURL(candidate).href);
		} catch (err) {
			tried.push(`${candidate} (${err?.code || err?.message || "failed"})`);
		}
	}

	throw new Error(
		`Could not load @earendil-works/pi-ai (or legacy @mariozechner/pi-ai). Set PI_AI_MODULE_PATH to pi-ai's dist/index.js.\nTried:\n- ${tried.join("\n- ")}`,
	);
}

async function loadPiAiOAuth(piAi) {
	if (typeof piAi?.getOAuthApiKey === "function") {
		return { getOAuthApiKey: piAi.getOAuthApiKey.bind(piAi) };
	}

	const imported = await importPiAiSubpath("/oauth");
	if (typeof imported.module?.getOAuthApiKey === "function") {
		return { getOAuthApiKey: imported.module.getOAuthApiKey.bind(imported.module) };
	}
	const tried = imported.tried;
	if (imported.module) tried.push("pi-ai/oauth (missing getOAuthApiKey export)");

	for (const candidate of collectModuleCandidates("oauth.js", "PI_AI_OAUTH_MODULE_PATH")) {
		if (!existsSync(candidate)) continue;
		try {
			const oauth = await import(pathToFileURL(candidate).href);
			if (typeof oauth.getOAuthApiKey === "function") {
				return { getOAuthApiKey: oauth.getOAuthApiKey.bind(oauth) };
			}
			tried.push(`${candidate} (missing getOAuthApiKey export)`);
		} catch (err) {
			tried.push(`${candidate} (${err?.code || err?.message || "failed"})`);
		}
	}

	return {
		getOAuthApiKey: undefined,
		error: `Could not load getOAuthApiKey. Set PI_AI_OAUTH_MODULE_PATH to pi-ai dist/oauth.js.\nTried:\n- ${tried.join("\n- ")}`,
	};
}

function parseExpiryTimestamp(expires) {
	if (typeof expires === "number" && Number.isFinite(expires)) {
		if (expires <= 0) return undefined;
		return expires < 1_000_000_000_000 ? expires * 1000 : expires;
	}

	if (typeof expires === "string") {
		const trimmed = expires.trim();
		if (!trimmed) return undefined;

		const numeric = Number(trimmed);
		if (Number.isFinite(numeric)) {
			return parseExpiryTimestamp(numeric);
		}

		const parsed = Date.parse(trimmed);
		if (Number.isFinite(parsed)) return parsed;
	}

	return undefined;
}

function getCachedOAuthAccess(entry, now = Date.now()) {
	if (!entry || typeof entry !== "object") return undefined;

	const apiKey = resolveConfigValue(entry.access);
	if (!apiKey) return undefined;

	const expiresAt = parseExpiryTimestamp(entry.expires);
	if (!expiresAt) return undefined;

	if (now + 30_000 >= expiresAt) return undefined;

	return {
		apiKey,
		accountId: entry.accountId,
	};
}

function pickFastModel(provider, requestedModel, piAi) {
	const models = typeof piAi.getModels === "function" ? piAi.getModels(provider) : [];
	if (!Array.isArray(models) || models.length === 0) {
		if (requestedModel) return { id: requestedModel, baseUrl: undefined };
		if (provider === "openai-codex") return { id: "gpt-5.1-codex-mini", baseUrl: "https://chatgpt.com/backend-api" };
		return { id: "claude-haiku-4-5", baseUrl: "https://api.anthropic.com" };
	}

	if (requestedModel) {
		const exact = models.find((m) => m.id === requestedModel);
		if (exact) return exact;
		return { ...models[0], id: requestedModel };
	}

	const preferredIds =
		provider === "openai-codex"
			? ["gpt-5.1-codex-mini", "gpt-5.3-codex-spark", "gpt-5.1"]
			: ["claude-haiku-4-5", "claude-3-5-haiku-latest", "claude-3-5-haiku-20241022"];

	for (const id of preferredIds) {
		const found = models.find((m) => m.id === id);
		if (found) return found;
	}

	const heuristic = models.find((m) => /mini|haiku|spark|flash|fast/i.test(m.id));
	return heuristic || models[0];
}

async function resolveApiKey(provider, auth, authPath, piAi) {
	const entry = auth?.[provider];
	if (!entry) {
		throw new Error(`No credentials for provider '${provider}' in ${authPath}`);
	}

	const inferredType = entry.type || (entry.access && entry.refresh ? "oauth" : entry.key ? "api_key" : undefined);

	if (inferredType === "api_key") {
		const key = resolveConfigValue(entry.key);
		if (!key) throw new Error(`API key for ${provider} is empty or unresolved.`);
		return { apiKey: key, accountId: entry.accountId };
	}

	if (inferredType !== "oauth") {
		throw new Error(`Unsupported credential type for ${provider}: ${String(entry.type || "unknown")}`);
	}

	const fallbackToken = getCachedOAuthAccess(entry);
	const oauth = await loadPiAiOAuth(piAi);

	if (typeof oauth.getOAuthApiKey !== "function") {
		if (fallbackToken) return fallbackToken;
		throw new Error(oauth.error || "Loaded pi-ai module does not export getOAuthApiKey");
	}

	const oauthCreds = {};
	for (const [k, v] of Object.entries(auth || {})) {
		if (v && (v.type === "oauth" || (v.access && v.refresh && v.expires))) {
			oauthCreds[k] = v;
		}
	}

	let refreshed;
	try {
		refreshed = await oauth.getOAuthApiKey(provider, oauthCreds);
	} catch (err) {
		if (fallbackToken) return fallbackToken;
		throw err;
	}

	if (!refreshed?.apiKey) {
		if (fallbackToken) return fallbackToken;
		throw new Error(`No OAuth credentials available for provider '${provider}'`);
	}

	const mergedCred = { type: "oauth", ...(entry || {}), ...(refreshed.newCredentials || {}) };
	auth[provider] = mergedCred;
	writeJson(authPath, auth);

	return {
		apiKey: refreshed.apiKey,
		accountId: mergedCred.accountId,
	};
}

function buildUserPrompt(query, purpose) {
	return `Search the internet for: ${query}\n\nPurpose: ${purpose}\n\nReturn a concise research summary with:\n- 3 to 7 key findings\n- for every finding: title, why it matters for this purpose, and a full canonical URL (https://...)\n- if multiple sources disagree, call that out\n- finish with a short recommendation on which source(s) to trust first.`;
}

function buildSystemPrompt() {
	return "You are a fast web research assistant. Always produce practical summaries and include full source URLs (no shortened links).";
}

function resolveResponsesUrl(baseUrl) {
	const normalized = String(baseUrl || "").replace(/\/+$/, "");
	if (!normalized) throw new Error("agent-model has no configured base URL.");
	return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

function resolveAgentModel(settings, modelsConfig, requestedModel) {
	const providerConfig = modelsConfig?.providers?.["agent-model"];
	if (!providerConfig) {
		throw new Error("No agent-model provider configuration found in Pi models.json.");
	}
	const modelId = requestedModel || settings?.defaultModel;
	if (!modelId) throw new Error("Could not determine the active agent-model model ID.");
	const configured = Array.isArray(providerConfig.models)
		? providerConfig.models.find((model) => model?.id === modelId)
		: undefined;
	if (!configured) throw new Error(`Model agent-model/${modelId} is not configured in Pi models.json.`);
	const apiKey = resolveConfigValue(providerConfig.apiKey);
	if (!apiKey) throw new Error("agent-model API key is empty or unresolved.");
	return { id: modelId, baseUrl: providerConfig.baseUrl, apiKey };
}

async function runResponsesSearch({ provider, model, apiKey, query, purpose, timeoutMs, baseUrl, headers = {} }) {
	const body = {
		model,
		store: false,
		stream: true,
		instructions: buildSystemPrompt(),
		input: [{ role: "user", content: [{ type: "input_text", text: buildUserPrompt(query, purpose) }] }],
		tools: [{ type: "web_search" }],
		tool_choice: "auto",
	};
	const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
	const requestHeaders = new Headers(headers);
	requestHeaders.set("authorization", `Bearer ${apiKey}`);
	requestHeaders.set("content-type", "application/json");
	requestHeaders.set("accept", "text/event-stream");
	const res = await fetch(resolveResponsesUrl(baseUrl), {
		method: "POST",
		headers: requestHeaders,
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) {
		const detail = await res.text();
		throw new Error(`${provider} Responses request failed (${res.status}): ${detail}`);
	}
	return parseResponsesText(res, provider);
}

async function parseResponsesText(res, provider = "Responses") {
	if (!res.body) throw new Error(`${provider} response had no body`);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let fallbackText = "";
	const consume = (chunk) => {
		const data = extractEventData(chunk);
		if (!data) return;
		let event;
		try {
			event = JSON.parse(data);
		} catch {
			return;
		}
		if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
		if (event.type === "response.output_text.done" && typeof event.text === "string") fallbackText = event.text;
		if (event.type === "response.output_item.done" && event.item?.type === "message") {
			const full = (Array.isArray(event.item.content) ? event.item.content : [])
				.filter((part) => part.type === "output_text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("\n");
			if (full) fallbackText = full;
		}
		if (event.type === "error") throw new Error(event.message || `${provider} stream failed`);
		if (event.type === "response.failed" || event.type === "response.incomplete") {
			throw new Error(event.response?.error?.message || `${provider} response ${event.type.split(".")[1]}`);
		}
	};
	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
		let end;
		while ((end = buffer.indexOf("\n\n")) >= 0) {
			consume(buffer.slice(0, end));
			buffer = buffer.slice(end + 2);
		}
		if (done) break;
	}
	if (buffer.trim()) consume(buffer);
	const finalText = (text || fallbackText).trim();
	if (!finalText) throw new Error(`${provider} returned an empty response`);
	return finalText;
}

function resolveCodexUrl(baseUrl = "https://chatgpt.com/backend-api") {
	const normalized = String(baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function extractEventData(chunk) {
	const payload = chunk
		.split(/\r?\n/)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.join("\n")
		.trim();
	if (!payload || payload === "[DONE]") return null;
	return payload;
}

async function runCodexSearch({ model, apiKey, accountId, query, purpose, timeoutMs, baseUrl }) {
	const tokenAccountId = accountId || decodeJwtAccountId(apiKey);
	if (!tokenAccountId) {
		throw new Error("Could not determine ChatGPT account ID for openai-codex token.");
	}

	return runResponsesSearch({
		provider: "openai-codex",
		model,
		apiKey,
		query,
		purpose,
		timeoutMs,
		baseUrl: resolveCodexUrl(baseUrl),
		headers: {
			"chatgpt-account-id": tokenAccountId,
			"OpenAI-Beta": "responses=experimental",
			originator: "pi-native-web-search-skill",
		},
	});
}

function buildAnthropicHeaders(apiKey) {
	const oauthToken = typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
	if (oauthToken) {
		return {
			authorization: `Bearer ${apiKey}`,
			"anthropic-version": "2023-06-01",
			"anthropic-beta": "claude-code-20250219,oauth-2025-04-20,web-search-2025-03-05",
			"content-type": "application/json",
			accept: "application/json",
			"x-app": "cli",
			"user-agent": "claude-cli/1.0.72 (external, cli)",
		};
	}
	return {
		"x-api-key": apiKey,
		"anthropic-version": "2023-06-01",
		"anthropic-beta": "web-search-2025-03-05",
		"content-type": "application/json",
		accept: "application/json",
	};
}

async function runAnthropicSearch({ model, apiKey, query, purpose, timeoutMs }) {
	const body = {
		model,
		max_tokens: 1800,
		temperature: 0,
		system: buildSystemPrompt(),
		tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
		messages: [{ role: "user", content: buildUserPrompt(query, purpose) }],
	};

	const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;

	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: buildAnthropicHeaders(apiKey),
		body: JSON.stringify(body),
		signal,
	});

	const payload = await res.text();
	if (!res.ok) {
		throw new Error(`Anthropic request failed (${res.status}): ${payload}`);
	}

	let parsed;
	try {
		parsed = JSON.parse(payload);
	} catch {
		throw new Error("Anthropic returned non-JSON response");
	}

	const text = (parsed.content || [])
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n\n")
		.trim();

	if (!text) {
		throw new Error("Anthropic returned no text content");
	}

	return text;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.query) {
		console.error(usage());
		process.exit(args.help ? 0 : 1);
	}

	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const settingsPath = join(agentDir, "settings.json");
	const modelsPath = join(agentDir, "models.json");
	const auth = readJson(authPath, {});
	const settings = readJson(settingsPath, {});
	const modelsConfig = readJson(modelsPath, {});

	const provider = pickProvider(args.provider, process.env.PI_PROVIDER, settings, auth);
	let model;
	let text;
	if (provider === "agent-model") {
		model = resolveAgentModel(settings, modelsConfig, args.model || process.env.PI_MODEL);
		text = await runResponsesSearch({
			provider,
			model: model.id,
			apiKey: model.apiKey,
			query: args.query,
			purpose: args.purpose,
			timeoutMs: args.timeoutMs,
			baseUrl: model.baseUrl,
		});
	} else {
		const piAi = await loadPiAi();
		model = pickFastModel(provider, args.model || process.env.PI_MODEL, piAi);
		const { apiKey, accountId } = await resolveApiKey(provider, auth, authPath, piAi);
		text =
			provider === "openai-codex"
				? await runCodexSearch({
						model: model.id,
						apiKey,
						accountId,
						query: args.query,
						purpose: args.purpose,
						timeoutMs: args.timeoutMs,
						baseUrl: model.baseUrl,
				  })
				: await runAnthropicSearch({
						model: model.id,
						apiKey,
						query: args.query,
						purpose: args.purpose,
						timeoutMs: args.timeoutMs,
				  });
	}

	if (args.json) {
		console.log(
			JSON.stringify(
				{
					provider,
					model: model.id,
					query: args.query,
					purpose: args.purpose,
					result: text,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(`Provider: ${provider}`);
	console.log(`Model: ${model.id}`);
	console.log("");
	console.log(text);
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
	main().catch((err) => {
		console.error(`Error: ${err?.message || err}`);
		process.exit(1);
	});
}

export {
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
	runResponsesSearch,
};
