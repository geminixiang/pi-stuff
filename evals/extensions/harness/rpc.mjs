import { spawn } from "node:child_process";
import { once } from "node:events";
import { createJsonlParser } from "./jsonl.mjs";

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

/**
 * Small pi --mode rpc client. Speaks the public JSONL protocol
 * (prompt, steer, get_state, abort, extension_ui_response). Written for this
 * harness; it is not derived from another project's client.
 */
export function startRpc(piBin, args, { cwd, env }) {
	const proc = spawn(piBin, args, {
		cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: false,
	});
	const pending = new Map();
	const listeners = new Set();
	let stderr = "";
	let settled = false;
	let nextId = 1;
	let exit = null;

	const failPending = (error) => {
		for (const waiter of pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		pending.clear();
	};

	const dispatch = (record) => {
		if (record?.type === "agent_settled") settled = true;
		if (record?.type === "agent_start") settled = false;
		if (record?.type === "extension_ui_request") answerUi(record);
		if (record?.type === "response" && record.id && pending.has(record.id)) {
			const waiter = pending.get(record.id);
			pending.delete(record.id);
			clearTimeout(waiter.timer);
			if (record.success === false) waiter.reject(new Error(record.error || `${record.command} failed`));
			else waiter.resolve(record);
			return;
		}
		for (const listener of listeners) listener(record);
	};

	const push = createJsonlParser(dispatch, (error, text) => {
		dispatch({ type: "parse_error", error: String(error?.message ?? error), raw: text.slice(0, 200) });
	});
	proc.stdout.on("data", push);
	proc.stderr.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
		if (stderr.length > 32_000) stderr = stderr.slice(-32_000);
	});
	proc.on("exit", (code, signal) => {
		exit = { code, signal };
		failPending(new Error(`pi exited code=${code} signal=${signal ?? ""}`));
	});

	function write(record) {
		if (!proc.stdin.writable) throw new Error("pi stdin is closed");
		proc.stdin.write(`${JSON.stringify(record)}\n`);
	}

	function answerUi(request) {
		if (!DIALOG_METHODS.has(request.method)) return;
		// PR3 scores approval. This harness confirms dialogs so a headless run
		// can finish; every dialog is kept on the trace by the caller.
		if (request.method === "confirm") write({ type: "extension_ui_response", id: request.id, confirmed: true });
		else if (request.method === "select")
			write({ type: "extension_ui_response", id: request.id, value: request.options?.[0] });
		else write({ type: "extension_ui_response", id: request.id, cancelled: true });
	}

	function request(command, timeoutMs) {
		const id = command.id ?? `c${nextId++}`;
		const payload = { ...command, id };
		const response = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`timed out waiting for ${payload.type}`));
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
		});
		write(payload);
		return response;
	}

	async function close() {
		if (proc.stdin.writable) proc.stdin.end();
		const exited = once(proc, "exit");
		const timed = new Promise((resolve) => setTimeout(resolve, 8_000, "timeout"));
		const first = await Promise.race([exited.then(() => "exit"), timed]);
		if (first === "timeout") {
			proc.kill("SIGTERM");
			const second = await Promise.race([once(proc, "exit").then(() => "exit"), new Promise((r) => setTimeout(r, 2_000, "kill"))]);
			if (second === "kill") proc.kill("SIGKILL");
		}
	}

	return {
		proc,
		request,
		on(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		get settled() {
			return settled;
		},
		get stderr() {
			return stderr;
		},
		get exit() {
			return exit;
		},
		close,
	};
}

export async function waitForIdle(client, { deadline, idleMs, ready }) {
	return new Promise((resolve) => {
		let timer;
		const finish = (reason) => {
			clearTimeout(timer);
			clearTimeout(hard);
			unsubscribe();
			resolve(reason);
		};
		const arm = () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				if (Date.now() >= deadline) finish("timeout");
				else if (ready()) finish("idle");
				else arm();
			}, idleMs);
		};
		const unsubscribe = client.on(() => {
			if (Date.now() >= deadline) finish("timeout");
			else arm();
		});
		const hard = setTimeout(() => finish("timeout"), Math.max(0, deadline - Date.now()));
		arm();
	});
}
