import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../harness/paths.mjs";
import { isAlive, readJobs } from "../../harness/jobs.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function httpUp(port) {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) });
		return response.status === 200 || response.status === 503;
	} catch {
		return false;
	}
}

function taskdPid(taskdHome) {
	try {
		return Number(readFileSync(join(taskdHome, "taskd.sock.lock"), "utf8").trim());
	} catch {
		return 0;
	}
}

export async function drive(ctx) {
	const statusPath = join(ctx.workspace, "host-status.json");
	let stderr = "";
	const child = spawn(process.execPath, [join(repoRoot, "evals/extensions/harness/t4-host.mjs")], {
		cwd: ctx.workspace,
		env: { ...process.env, EVAL_WORKSPACE: ctx.workspace, EVAL_STATUS: statusPath },
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.on("data", () => {});
	child.stderr?.on("data", (chunk) => {
		stderr += chunk.toString("utf8");
	});
	const deadline = Date.now() + 20_000;
	while (!existsSync(statusPath)) {
		if (child.exitCode !== null) throw new Error(`host exited ${child.exitCode}\n${stderr}`);
		if (Date.now() > deadline) throw new Error(`host did not become ready\n${stderr}`);
		await sleep(40);
	}
	const status = JSON.parse(readFileSync(statusPath, "utf8"));
	if (!status.ok) throw new Error(status.error || "host failed");
	if (!(await httpUp(status.port))) throw new Error("service was not listening before the kill");
	process.kill(child.pid, "SIGKILL");
	await sleep(400);
	const buildAlive = isAlive(status.buildPid);
	const daemonPid = taskdPid(ctx.paths.taskdHome);
	ctx.trace.toolCalls.push(
		{
			name: "supervisor_start",
			args: { command: "node server.mjs", name: "flaky-http" },
			result: { text: "started", details: { port: status.port }, isError: false },
		},
		{
			name: "bash_bg",
			args: { command: "node build.mjs", label: "build" },
			result: { text: "started", details: { id: status.buildId, state: "running", pid: status.buildPid }, isError: false },
		},
	);
	ctx.trace.observations.push({
		type: "hard-kill",
		taskdAlive: isAlive(daemonPid),
		taskdPid: daemonPid,
		portListening: await httpUp(status.port),
		port: status.port,
		buildAlive,
		buildPid: status.buildPid,
		hostKilled: !isAlive(child.pid),
	});
	const jobs = readJobs(ctx.paths.bgDir);
	ctx.trace.observations.push({ type: "bg-registry", seq: jobs.seq, states: jobs.jobs.map((job) => job.state) });
}
