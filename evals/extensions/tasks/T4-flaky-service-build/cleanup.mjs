import { killRecordedJobs, killTaskd } from "../../harness/sandbox.mjs";

function signal(pid) {
	if (!pid) return;
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
}

export async function cleanup(ctx) {
	const kill = ctx.trace.observations.find((item) => item.type === "hard-kill");
	signal(kill?.buildPid);
	killRecordedJobs(ctx.paths.bgDir);
	killTaskd(ctx.paths.taskdHome);
}
