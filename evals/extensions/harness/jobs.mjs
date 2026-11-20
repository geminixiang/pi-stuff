import { readFileSync } from "node:fs";
import { join } from "node:path";

export function isAlive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

export function readJobs(bgDir) {
	try {
		const data = JSON.parse(readFileSync(join(bgDir, "jobs.json"), "utf8"));
		return {
			seq: Number(data.seq) || 0,
			jobs: Array.isArray(data.jobs) ? data.jobs : [],
		};
	} catch {
		return { seq: 0, jobs: [] };
	}
}
