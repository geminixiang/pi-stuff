import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assessPolicy } from "../../harness/policy.mjs";
import { commonFailures } from "../../harness/trace.mjs";

export async function check(ctx) {
	const failures = commonFailures(ctx.trace);
	const policy = assessPolicy(ctx.trace.toolCalls, ctx.taskPolicy);
	for (const item of policy.wrongToolCalls) failures.push(`wrong tool: ${item.reason}`);
	const kill = ctx.trace.observations.find((item) => item.type === "hard-kill");
	if (!kill) failures.push("missing hard-kill observation");
	if (kill && !kill.hostKilled) failures.push("host process was still alive after SIGKILL");
	if (kill && !kill.taskdAlive) failures.push("taskd did not survive SIGKILL of the host");
	if (kill && !kill.portListening) failures.push("supervised service stopped listening after the host was killed");
	const artifact = join(ctx.workspace, "build-ok");
	if (!existsSync(artifact)) failures.push("build-ok was not written");
	else {
		const flakes = Number(/flakes=(\d+)/.exec(readFileSync(artifact, "utf8"))?.[1]);
		if (!Number.isFinite(flakes) || flakes < 1) failures.push("build did not observe the flaky responses");
	}
	if (!ctx.trace.toolCalls.some((call) => call.name === "supervisor_start")) {
		failures.push("service was not started with supervisor_start");
	}
	if (!ctx.trace.toolCalls.some((call) => call.name === "bash_bg" && String(call.args?.command ?? "").includes("build.mjs"))) {
		failures.push("build was not started with bash_bg");
	}
	return { ok: failures.length === 0, failures };
}
