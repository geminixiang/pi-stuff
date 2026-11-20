import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { repoRoot } from "./paths.mjs";
import { messageText, recordCrash } from "./trace.mjs";

const bgPath = join(repoRoot, "packages/pi-bg-bash/extensions/index.ts");
const loopPath = join(repoRoot, "packages/pi-loop/extensions/index.ts");
const supervisorPath = join(repoRoot, "packages/pi-supervisor/extensions/pi-supervisor.ts");

function stamped(path) {
	const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	return `${pathToFileURL(path).href}?eval=${stamp}`;
}

/**
 * Load the product extensions into a fresh module instance.
 * pi-supervisor captures PI_TASKD_HOME when the module is evaluated, so each
 * session imports it with a cache-busting query after the sandbox env is set.
 */
export async function loadProductExtensions(pi) {
	const [bg, loop, supervisor] = await Promise.all([
		import(stamped(bgPath)),
		import(stamped(loopPath)),
		import(stamped(supervisorPath)),
	]);
	const loadBg = bg.default ?? bg.createBgBash?.();
	const loadLoop = loop.default;
	const loadSupervisor = supervisor.default;
	if (typeof loadBg !== "function" || typeof loadLoop !== "function" || typeof loadSupervisor !== "function") {
		throw new Error("product extension module did not export a loader function");
	}
	loadBg(pi);
	loadLoop(pi);
	loadSupervisor(pi);
}

function runBash(command, cwd, timeoutMs) {
	return new Promise((resolve) => {
		let out = "";
		let child;
		try {
			child = spawn("bash", ["-c", command], { cwd, env: process.env });
		} catch (error) {
			resolve({ code: null, out: String(error?.message ?? error) });
			return;
		}
		const add = (chunk) => {
			if (out.length < 16_000) out += chunk.toString("utf8");
		};
		child.stdout?.on("data", add);
		child.stderr?.on("data", add);
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: null, out: out + error.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, out });
		});
	});
}

function createUi(trace) {
	return {
		setStatus(key, text) {
			trace.status ??= {};
			trace.status[key] = text;
		},
		notify(message, notifyType) {
			trace.notifications.push({
				source: "ui.notify",
				text: String(message ?? ""),
				details: { notifyType: notifyType ?? "info" },
			});
		},
		setWidget() {},
		setTitle() {},
		custom() {
			return undefined;
		},
		onTerminalInput() {
			return () => {};
		},
	};
}

/**
 * Fake ExtensionAPI in the shape used by packages/pi-bg-bash/test and
 * packages/pi-loop/test. Several extensions can register; handlers are a list.
 * `bash` is a stand-in for pi's built-in tool so a scripted drive can misuse it.
 */
export async function openSession({ workspace, trace, headless, sessionId }) {
	const hooks = new Map();
	const tools = {};
	const commands = {};
	const renderers = {};
	const ui = headless ? undefined : createUi(trace);
	const state = { idle: true };
	const ctx = {
		cwd: workspace,
		hasUI: Boolean(ui),
		mode: headless ? "rpc" : "tui",
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
		},
		isIdle: () => state.idle,
		hasPendingMessages: () => false,
		ui,
	};
	const pi = {
		on(name, fn) {
			const list = hooks.get(name) ?? [];
			list.push(fn);
			hooks.set(name, list);
		},
		registerTool(tool) {
			tools[tool.name] = tool;
		},
		registerCommand(name, command) {
			commands[name] = command;
		},
		registerMessageRenderer(type, fn) {
			renderers[type] = fn;
		},
		sendMessage(message, opts) {
			trace.notifications.push({
				source: "sendMessage",
				text: messageText(message),
				details: message?.details ?? {},
				opts: opts ?? {},
			});
		},
		sendUserMessage(message, opts) {
			trace.notifications.push({
				source: "sendUserMessage",
				text: typeof message === "string" ? message : messageText(message),
				details: {},
				opts: opts ?? {},
			});
		},
		appendEntry() {},
	};

	await loadProductExtensions(pi);
	if (typeof tools.bash_bg?.execute !== "function") {
		throw new Error("bash_bg was not registered; the product extension did not load");
	}

	tools.bash = {
		name: "bash",
		async execute(_id, params) {
			const command = String(params?.command ?? "");
			const run = await runBash(command, workspace, 30_000);
			const text = `$ ${command}\n${run.out}`.trimEnd();
			if (run.code !== 0) {
				const error = new Error(text || `bash exited ${run.code}`);
				error.result = { text, details: { exitCode: run.code } };
				throw error;
			}
			return { content: [{ type: "text", text }], details: { exitCode: run.code } };
		},
	};

	async function emit(name, event) {
		for (const fn of hooks.get(name) ?? []) {
			try {
				await fn(event, ctx);
			} catch (error) {
				recordCrash(trace, error, name);
			}
		}
	}

	return {
		tools,
		async start() {
			await emit("session_start", { reason: "startup" });
		},
		async shutdown(reason) {
			await emit("session_shutdown", { reason });
		},
		async callTool(name, args) {
			const started = Date.now();
			const call = { name, args: args ?? {}, result: null, durationMs: null, error: null };
			trace.toolCalls.push(call);
			const tool = tools[name];
			if (!tool) {
				call.error = `unknown tool ${name}`;
				call.result = { text: call.error, details: {}, isError: true };
				return call.result;
			}
			state.idle = false;
			try {
				const result = await tool.execute("eval", args ?? {}, undefined, undefined, ctx);
				call.durationMs = Date.now() - started;
				call.result = {
					text: messageText(result),
					details: result?.details ?? {},
					isError: false,
				};
				return call.result;
			} catch (error) {
				call.durationMs = Date.now() - started;
				call.error = error instanceof Error ? error.message : String(error);
				call.result = {
					text: call.error,
					details: error?.result?.details ?? {},
					isError: true,
				};
				return call.result;
			} finally {
				state.idle = true;
			}
		},
		probeRenderer() {
			const theme = {
				fg: (_color, text) => text,
				bg: (_color, text) => text,
			};
			const sample = {
				content:
					trace.notifications.find((note) => note.details?.kind)?.text ??
					"Background job bg0 [exit 0 after 1s] sample\n(no output)",
				details: { kind: "exit", ok: true, state: "exited", exitCode: 0 },
			};
			for (const [type, render] of Object.entries(renderers)) {
				try {
					const widget = render(sample, { expanded: false, outputPad: 0 }, theme);
					if (widget && typeof widget.render === "function") widget.render(80);
				} catch (error) {
					trace.uiExceptions.push({ ...recordShape(error), where: `renderer:${type}` });
				}
			}
		},
	};
}

function recordShape(error) {
	if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack ?? "" };
	return { name: "Error", message: String(error), stack: "" };
}
