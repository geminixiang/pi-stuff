import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createClock } from "./clock.mjs";
import { isAlive, readJobs } from "./jobs.mjs";
import { applySandboxEnv, createSandbox, disposeSandbox } from "./sandbox.mjs";
import { openSession } from "./session.mjs";
import { captureProcessErrors } from "./errors.mjs";
import { createTrace, serializeError } from "./trace.mjs";

async function waitFor(pred, timeoutMs, label, clock) {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await clock.sleep(20);
	}
}

export async function createHost({ workspace, trace, headless, sessionId, bgDir, extensions, entries }) {
	const sharedEntries = entries ?? [];
	const sessionOptions = { workspace, trace, headless, sessionId, extensions, entries: sharedEntries };
	let current = await openSession(sessionOptions);
	return {
		start: () => current.start(),
		callTool: (name, args) => current.callTool(name, args),
		shutdown: (reason) => current.shutdown(reason),
		endTurn: () => current.endTurn(),
		probeRenderer: () => current.probeRenderer(),
		async reload() {
			const running = readJobs(bgDir).jobs.filter((job) => job.state === "running" && job.pid);
			await current.shutdown("reload");
			current = await openSession(sessionOptions);
			await current.start();
			const alivePids = running.map((job) => job.pid).filter((pid) => isAlive(pid));
			trace.observations.push({
				type: "alive-after-reload",
				alive: running.length > 0 && alivePids.length === running.length,
				jobIds: running.map((job) => job.id),
				pids: running.map((job) => job.pid),
				alivePids,
			});
		},
		async suspend(reason = "resume") {
			await current.shutdown(reason);
		},
		async boot() {
			current = await openSession(sessionOptions);
			await current.start();
		},
		async resume() {
			await current.shutdown("resume");
			current = await openSession(sessionOptions);
			await current.start();
		},
	};
}

export async function runDeterministic(task) {
	const paths = createSandbox(`pi-eval-${task.id}-`);
	applySandboxEnv(paths);
	const trace = createTrace({ mode: "deterministic", headless: task.headless, taskId: task.id });
	const release = captureProcessErrors(trace);
	const clock = await createClock(task.clock ?? "real");
	const started = performance.now();
	const entries = [];
	let host;
	const ctx = {
		workspace: paths.workspace,
		paths,
		mode: "deterministic",
		headless: Boolean(task.headless),
		trace,
		taskPolicy: task.toolPolicy ?? {},
		clock,
		callTool: (name, args) => host.callTool(name, args),
		reload: () => host.reload(),
		resume: () => host.resume(),
		suspend: (reason) => host.suspend(reason),
		boot: () => host.boot(),
		endTurn: () => host.endTurn(),
		waitFor: (pred, timeoutMs, label) => waitFor(pred, timeoutMs, label, clock),
	};
	try {
		host = await createHost({
			workspace: paths.workspace,
			trace,
			headless: Boolean(task.headless),
			sessionId: `eval-${task.id}`,
			bgDir: paths.bgDir,
			extensions: task.extensions,
			entries,
		});
		const setup = await import(pathToFileURL(join(task.dir, "setup.mjs")).href);
		await setup.setup(ctx);
		await host.start();
		const drive = await import(pathToFileURL(join(task.dir, "drive.mjs")).href);
		try {
			await drive.drive(ctx);
		} catch (error) {
			trace.driveError = serializeError(error);
		}
		if (task.headless) host.probeRenderer();
		const checkMod = await import(pathToFileURL(join(task.dir, "check.mjs")).href);
		const outcome = await checkMod.check(ctx);
		return { trace, outcome, wallTimeMs: Math.round(performance.now() - started), paths };
	} finally {
		try {
			await host?.shutdown("quit");
		} catch (error) {
			trace.crashes.push({ ...serializeError(error), where: "shutdown" });
		}
		try {
			const cleanup = await import(pathToFileURL(join(task.dir, "cleanup.mjs")).href);
			await cleanup.cleanup(ctx);
		} catch {
			// cleanup is best-effort; dispose still removes the sandbox
		}
		release();
		clock.dispose();
		disposeSandbox(paths);
	}
}
