import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { findPi, rpcLaunchArgs } from "./extensions.mjs";
import { isAlive, readJobs } from "./jobs.mjs";
import { startRpc, waitForIdle } from "./rpc.mjs";
import { applySandboxEnv, createSandbox, disposeSandbox } from "./sandbox.mjs";
import { absorbEvent, createTrace, scanStderr, serializeError } from "./trace.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function promptText(task) {
	return readFileSync(join(task.dir, "prompt.md"), "utf8").trim();
}

async function httpUp(port) {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
		return response.status === 200 || response.status === 503;
	} catch {
		return false;
	}
}

async function hardKillHost(client, ctx) {
	const port = Number(readFileSync(join(ctx.workspace, "port.txt"), "utf8").trim());
	const build = readJobs(ctx.paths.bgDir).jobs.find((job) => String(job.command ?? "").includes("build.mjs"));
	client.proc.kill("SIGKILL");
	await sleep(400);
	let taskdPid = 0;
	try {
		taskdPid = Number(readFileSync(join(ctx.paths.taskdHome, "taskd.sock.lock"), "utf8").trim());
	} catch {
		taskdPid = 0;
	}
	ctx.trace.observations.push({
		type: "hard-kill",
		taskdAlive: isAlive(taskdPid),
		taskdPid,
		portListening: await httpUp(port),
		port,
		buildAlive: isAlive(build?.pid),
		buildPid: build?.pid ?? null,
		hostKilled: true,
	});
}

function hasExit(trace) {
	return trace.notifications.some((note) => note.details?.kind === "exit" || /\[exit /.test(note.text ?? ""));
}

async function reloadLive(client, trace, bgDir) {
	const running = readJobs(bgDir).jobs.filter((job) => job.state === "running" && job.pid);
	if (!running.length) {
		trace.observations.push({ type: "alive-after-reload", alive: false, jobIds: [], pids: [], alivePids: [] });
		return;
	}
	const response = await client.request({ type: "prompt", message: "/eval-reload" }, 20_000);
	if (response.data?.disposition !== "handled") {
		throw new Error(`/eval-reload disposition was ${response.data?.disposition ?? "missing"}`);
	}
	await sleep(200);
	const alivePids = running.map((job) => job.pid).filter((pid) => isAlive(pid));
	trace.observations.push({
		type: "alive-after-reload",
		alive: alivePids.length === running.length,
		jobIds: running.map((job) => job.id),
		pids: running.map((job) => job.pid),
		alivePids,
	});
}

export async function runLive(task, { piBin, model, provider }) {
	const paths = createSandbox(`pi-eval-live-${task.id}-`);
	applySandboxEnv(paths);
	const trace = createTrace({ mode: "live", headless: true, taskId: task.id });
	const started = Date.now();
	const deadline = started + (task.timeoutMs ?? 180_000);
	const client = startRpc(findPi(piBin), rpcLaunchArgs({ model, provider, reloadCommand: true }), {
		cwd: paths.workspace,
		env: {
			...process.env,
			HOME: paths.home,
			USERPROFILE: paths.home,
			PI_CODING_AGENT_DIR: paths.agentDir,
			PI_BG_BASH_DIR: paths.bgDir,
			PI_TASKD_HOME: paths.taskdHome,
		},
	});
	const stopEvents = client.on((event) => absorbEvent(trace, event));
	const ctx = {
		workspace: paths.workspace,
		paths,
		mode: "live",
		headless: true,
		trace,
		taskPolicy: task.toolPolicy ?? {},
	};
	try {
		const setup = await import(pathToFileURL(join(task.dir, "setup.mjs")).href);
		await setup.setup(ctx);
		await client.request({ type: "prompt", message: promptText(task) }, 30_000);
		const idle = { deadline, idleMs: 400 };
		await waitForIdle(client, { ...idle, ready: () => client.settled });
		if (task.live?.hardKill) {
			await waitForIdle(client, {
				deadline,
				idleMs: 400,
				ready: () => existsSync(join(paths.workspace, "build-ok")),
			});
			await hardKillHost(client, ctx);
		} else if (task.live?.reloadWhileRunning) {
			await reloadLive(client, trace, paths.bgDir);
			await waitForIdle(client, { ...idle, idleMs: 800, ready: () => client.settled && hasExit(trace) });
		} else {
			await waitForIdle(client, { ...idle, idleMs: 800, ready: () => client.settled && hasExit(trace) });
		}
		if (task.live?.followUp && hasExit(trace)) {
			const before = trace.toolCalls.filter((call) => call.name === "bash_bg").length;
			await client.request({ type: "prompt", message: task.live.followUp }, 30_000);
			await waitForIdle(client, {
				...idle,
				idleMs: 800,
				ready: () => client.settled && trace.toolCalls.filter((call) => call.name === "bash_bg").length > before,
			});
		}
		const checkMod = await import(pathToFileURL(join(task.dir, "check.mjs")).href);
		const outcome = await checkMod.check(ctx);
		return { trace, outcome, wallTimeMs: Date.now() - started };
	} catch (error) {
		if (!trace.driveError) trace.driveError = serializeError(error);
		let outcome = { ok: false, failures: [`live runner: ${trace.driveError.message}`] };
		try {
			const checkMod = await import(pathToFileURL(join(task.dir, "check.mjs")).href);
			outcome = await checkMod.check(ctx);
			if (!outcome.ok) outcome.failures = [...outcome.failures];
			else outcome = { ok: false, failures: [`live runner: ${trace.driveError.message}`] };
		} catch (checkError) {
			outcome.failures.push(checkError instanceof Error ? checkError.message : String(checkError));
		}
		return { trace, outcome, wallTimeMs: Date.now() - started };
	} finally {
		stopEvents();
		scanStderr(trace, client.stderr);
		try {
			const cleanup = await import(pathToFileURL(join(task.dir, "cleanup.mjs")).href);
			await cleanup.cleanup(ctx);
		} catch {
			// dispose removes the sandbox either way
		}
		await client.close();
		disposeSandbox(paths);
	}
}
