export function createTrace({ mode, headless, taskId }) {
	return {
		mode,
		headless: Boolean(headless),
		taskId,
		toolCalls: [],
		notifications: [],
		observations: [],
		crashes: [],
		uiExceptions: [],
		uiRequests: [],
		usageSamples: [],
		tokens: null,
		stderr: "",
		driveError: null,
	};
}

export function serializeError(error) {
	if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack ?? "" };
	return { name: "Error", message: String(error), stack: "" };
}

export function isUiFailure(text) {
	return /pi-tui|reading 'ui'|reading 'setStatus'|reading 'notify'|reading 'setWidget'/.test(text);
}

export function recordCrash(trace, error, where) {
	const item = { ...serializeError(error), where };
	trace.crashes.push(item);
	if (isUiFailure(`${item.message}\n${item.stack}`)) trace.uiExceptions.push(item);
	return item;
}

export function commonFailures(trace) {
	const failures = [];
	for (const crash of trace.crashes) failures.push(`crash (${crash.where}): ${crash.message}`);
	if (trace.driveError) failures.push(`drive: ${trace.driveError.message}`);
	return failures;
}

export function messageText(value) {
	if (!value) return "";
	if (typeof value === "string") return value;
	if (typeof value.content === "string") return value.content;
	if (Array.isArray(value.content)) return value.content.map((part) => part?.text ?? "").join("\n");
	if (Array.isArray(value)) return value.map((part) => part?.text ?? "").join("\n");
	return "";
}

function inferDetails(text) {
	const id = /Background job (bg\d+)/.exec(text)?.[1];
	const exit = /\[exit (\d+)/.exec(text);
	const kind = /\[(exit|killed|failed)\b/.test(text) ? "exit" : undefined;
	if (!id && !kind) return {};
	return {
		id,
		kind,
		exitCode: exit ? Number(exit[1]) : undefined,
		ok: kind === "exit" ? /\[exit 0\b/.test(text) || /\(ok\)/.test(text) : undefined,
	};
}

/** Fold one pi RPC/session event into the shared trace shape. */
export function absorbEvent(trace, event) {
	if (!event || typeof event !== "object") return;
	if (event.type === "message_update") {
		if (event.usage) trace.usageSamples.push(event.usage);
		return;
	}
	if (event.type === "tool_execution_start") {
		trace.toolCalls.push({
			name: event.toolName,
			args: event.args ?? {},
			toolCallId: event.toolCallId,
			result: null,
			durationMs: null,
		});
		return;
	}
	if (event.type === "tool_execution_end") {
		const call =
			[...trace.toolCalls].reverse().find((item) => item.toolCallId === event.toolCallId) ??
			[...trace.toolCalls].reverse().find((item) => item.name === event.toolName && !item.result);
		if (call) {
			const text = messageText(event.result);
			call.durationMs = event.durationMs ?? null;
			call.result = {
				text,
				details: event.result?.details ?? {},
				isError: Boolean(event.isError),
			};
			if (event.isError) call.error = text || "tool error";
		}
		return;
	}
	if (event.type === "message_end") {
		const message = event.message ?? {};
		if (message.role === "assistant" && trace.usageSamples.length) {
			const usage = message.usage ?? trace.usageSamples[trace.usageSamples.length - 1];
			trace.tokens = addUsage(trace.tokens, usage);
			trace.usageSamples = [];
		}
		const text = messageText(message);
		const custom = message.customType;
		if (custom === "bg-bash" || text.startsWith("Background job") || text.startsWith("Supervisor process")) {
			const details = message.details && Object.keys(message.details).length ? message.details : inferDetails(text);
			trace.notifications.push({ source: custom ? `message:${custom}` : "message", text, details });
		}
		return;
	}
	if (event.type === "extension_ui_request") {
		trace.uiRequests.push({ id: event.id, method: event.method, message: event.message, notifyType: event.notifyType });
		if (event.method === "notify") {
			trace.notifications.push({
				source: "ui.notify",
				text: String(event.message ?? ""),
				details: { notifyType: event.notifyType ?? "info" },
			});
		}
		return;
	}
	if (event.type === "extension_error") {
		recordCrash(trace, new Error(String(event.error ?? "extension error")), `extension_error:${event.event ?? ""}`);
	}
}

function addUsage(total, usage) {
	const base = total ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	return {
		input: base.input + (usage.input ?? 0),
		output: base.output + (usage.output ?? 0),
		cacheRead: base.cacheRead + (usage.cacheRead ?? 0),
		cacheWrite: base.cacheWrite + (usage.cacheWrite ?? 0),
		totalTokens: base.totalTokens + (usage.totalTokens ?? 0),
	};
}

export function scanStderr(trace, stderr) {
	trace.stderr = stderr.slice(-4000);
	if (/uncaughtException|Uncaught |UnhandledPromiseRejection/.test(stderr)) {
		recordCrash(trace, new Error("stderr reported an uncaught exception"), "stderr");
	}
	if (isUiFailure(stderr)) {
		trace.uiExceptions.push({
			name: "Error",
			message: "stderr reported a ui or pi-tui failure",
			stack: trace.stderr,
			where: "stderr",
		});
	}
}
