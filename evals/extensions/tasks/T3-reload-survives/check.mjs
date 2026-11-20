import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assessPolicy } from "../../harness/policy.mjs";
import { commonFailures } from "../../harness/trace.mjs";

function bgNumber(id) {
	const match = /^bg(\d+)$/.exec(id ?? "");
	return match ? Number(match[1]) : 0;
}

export async function check(ctx) {
	const failures = commonFailures(ctx.trace);
	const policy = assessPolicy(ctx.trace.toolCalls, ctx.taskPolicy);
	for (const item of policy.wrongToolCalls) failures.push(`wrong tool: ${item.reason}`);

	const observation = ctx.trace.observations.find((item) => item.type === "alive-after-reload");
	if (!observation?.alive) failures.push("background job was not alive after reload");
	const logPath = join(ctx.workspace, "job.log");
	if (!existsSync(logPath) || !readFileSync(logPath, "utf8").includes("tick-")) {
		failures.push("job.log has no tick lines");
	}
	for (const id of observation?.jobIds ?? []) {
		const exits = ctx.trace.notifications.filter((note) => note.details?.kind === "exit" && note.details?.id === id);
		if (exits.length !== 1) failures.push(`job ${id} was notified ${exits.length} times on exit`);
	}
	const survivor = bgNumber(observation?.jobIds?.[0]);
	const later = ctx.trace.toolCalls
		.filter((call) => call.name === "bash_bg")
		.map((call) => bgNumber(call.result?.details?.id))
		.filter((n) => n > survivor);
	if (!later.length) failures.push("job ids did not continue after reload");
	const logger = ctx.trace.toolCalls.find(
		(call) => call.name === "bash_bg" && String(call.args?.command ?? "").includes("job.log"),
	);
	if (!logger) failures.push("bash_bg was not used for the log-writing job");
	if (logger && logger.result?.details?.state !== "running") {
		failures.push("logger bash_bg did not return while the job was still running");
	}
	return { ok: failures.length === 0, failures };
}
