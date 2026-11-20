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

export const PRODUCT_EXTENSIONS = ["pi-bg-bash", "pi-loop", "pi-supervisor"];

/**
 * Load the product extensions into a fresh module instance.
 * pi-supervisor captures PI_TASKD_HOME when the module is evaluated, so each
 * session imports it with a cache-busting query after the sandbox env is set.
 * Fake-clock tasks pass a subset so a mocked timer does not stall taskd startup.
 */
export async function loadProductExtensions(pi, names = PRODUCT_EXTENSIONS) {
	const wanted = new Set(names);
	if (wanted.has("pi-bg-bash")) {
		const bg = await import(stamped(bgPath));
		const loadBg = bg.default ?? bg.createBgBash?.();
		if (typeof loadBg !== "function") throw new Error("pi-bg-bash did not export a loader");
		loadBg(pi);
	}
	if (wanted.has("pi-loop")) {
		const loop = await import(stamped(loopPath));
		if (typeof loop.default !== "function") throw new Error("pi-loop did not export a loader");
		loop.default(pi);
	}
	if (wanted.has("pi-supervisor")) {
		const supervisor = await import(stamped(supervisorPath));
		if (typeof supervisor.default !== "function") throw new Error("pi-supervisor did not export a loader");
		supervisor.default(pi);
	}
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
export async function openSession({ workspace, trace, headless, sessionId, extensions, entries }) {
	const hooks = new Map();
	const tools = {};
	const commands = {};
	const renderers = {};
	const branch = entries ?? [];
	const ui = headless ? undefined : createUi(trace);
	const state = { idle: true, turn: false };
	const ctx = {
		cwd: workspace,
		hasUI: Boolean(ui),
		mode: headless ? "rpc" : "tui",
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
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
			// A delivered loop prompt starts a turn. The agent stays busy until endTurn,
			// matching the pi-loop tests, so a fake-clock jump cannot re-enter mid-turn.
			state.turn = true;
			state.idle = false;
			trace.notifications.push({
				source: "sendUserMessage",
				text: typeof message === "string" ? message : messageText(message),
				details: {},
				opts: opts ?? {},
				at: Date.now(),
			});
		},
		appendEntry(customType, data) {
			branch.push({ type: "custom", customType, data: structuredClone(data) });
		},
	};

	await loadProductExtensions(pi, extensions);
	const loadBg = !extensions || extensions.includes("pi-bg-bash");
	if (loadBg && typeof tools.bash_bg?.execute !== "function") {
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
				if (!state.turn) state.idle = true;
			}
		},
		async endTurn() {
			state.turn = false;
			state.idle = true;
			await emit("agent_end", {});
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
