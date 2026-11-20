import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

/** Captured before any eval code changes HOME. */
export const realHome = homedir();
const realPi = resolve(realHome, ".pi");

export function assertIsolated(dir) {
	const resolved = resolve(dir);
	if (resolved === realPi || resolved.startsWith(realPi + sep)) {
		throw new Error(`refusing to touch real ~/.pi at ${resolved}`);
	}
	const temp = resolve(tmpdir());
	if (resolved !== temp && !resolved.startsWith(temp + sep)) {
		throw new Error(`sandbox ${resolved} is outside the temp dir ${temp}`);
	}
	return resolved;
}

/**
 * A private directory tree. Extension state is pointed here with
 * PI_CODING_AGENT_DIR, PI_BG_BASH_DIR, and PI_TASKD_HOME. HOME for the
 * whole eval process is a separate suite directory, also under temp,
 * so a late homedir() fallback cannot reach the real ~/.pi.
 */
export function createSandbox(prefix) {
	const root = assertIsolated(mkdtempSync(join(tmpdir(), prefix)));
	const paths = {
		root,
		home: join(root, "home"),
		agentDir: join(root, "agent"),
		bgDir: join(root, "bg-bash"),
		taskdHome: join(root, "taskd"),
		workspace: join(root, "workspace"),
	};
	for (const dir of Object.values(paths)) {
		if (dir !== root) mkdirSync(assertIsolated(dir), { recursive: true });
	}
	return paths;
}

/** Point homedir() at a suite temp directory for the rest of the process. */
export function pinProcessHome(paths) {
	assertIsolated(paths.home);
	process.env.HOME = paths.home;
	process.env.USERPROFILE = paths.home;
}

export function applySandboxEnv(paths) {
	for (const dir of [paths.agentDir, paths.bgDir, paths.taskdHome, paths.workspace]) {
		assertIsolated(dir);
	}
	process.env.PI_CODING_AGENT_DIR = paths.agentDir;
	process.env.PI_BG_BASH_DIR = paths.bgDir;
	process.env.PI_TASKD_HOME = paths.taskdHome;
	delete process.env.PI_TASKD_SOCKET;
}

function isAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function signal(pid, sig) {
	try {
		process.kill(pid, sig);
	} catch {
		// already gone
	}
}

export function killRecordedJobs(bgDir) {
	let jobs = [];
	try {
		const data = JSON.parse(readFileSync(join(bgDir, "jobs.json"), "utf8"));
		jobs = Array.isArray(data.jobs) ? data.jobs : [];
	} catch {
		return;
	}
	for (const job of jobs) {
		if (!job.pid || !isAlive(job.pid)) continue;
		signal(-job.pid, "SIGTERM");
		signal(job.pid, "SIGTERM");
	}
}

export function killTaskd(taskdHome) {
	let pid = 0;
	try {
		pid = Number(readFileSync(join(taskdHome, "taskd.sock.lock"), "utf8").trim());
	} catch {
		return;
	}
	if (!pid || !isAlive(pid)) return;
	signal(pid, "SIGTERM");
	const deadline = Date.now() + 500;
	while (isAlive(pid) && Date.now() < deadline) {
		spawnSync("sleep", ["0.05"]);
	}
	if (isAlive(pid)) signal(pid, "SIGKILL");
}

export function disposeSandbox(paths) {
	killRecordedJobs(paths.bgDir);
	killTaskd(paths.taskdHome);
	rmSync(paths.root, { recursive: true, force: true });
}
