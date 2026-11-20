import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assessPolicy } from "../../harness/policy.mjs";
import { commonFailures } from "../../harness/trace.mjs";

export async function check(ctx) {
	const failures = commonFailures(ctx.trace);
	const policy = assessPolicy(ctx.trace.toolCalls, ctx.taskPolicy);
	for (const item of policy.wrongToolCalls) failures.push(`wrong tool: ${item.reason}`);

	const bashBg = ctx.trace.toolCalls.filter((call) => call.name === "bash_bg");
	const server = bashBg.find((call) => String(call.args?.command ?? "").includes("server.mjs"));
	const waiter = bashBg.find((call) => call.args?.wait_until || call.args?.notify_on);
	if (!server) failures.push("bash_bg was not used to start server.mjs");
	if (server && server.result?.details?.state !== "running") {
		failures.push("server bash_bg did not return while the server was still running");
	}
	if (!waiter) failures.push("no bash_bg call used wait_until or notify_on");
	else if (waiter.result?.details?.state !== "running") {
		failures.push("wait_until/notify_on call blocked until the condition finished");
	}
	const exit = ctx.trace.notifications.find(
		(note) => note.details?.kind === "exit" && note.details?.id === waiter?.result?.details?.id && note.details?.ok === true,
	);
	if (!exit) failures.push("missing successful exit notification for the wait");
	const readyPath = join(ctx.workspace, "ready");
	if (!existsSync(readyPath) || !readFileSync(readyPath, "utf8").trim()) failures.push("ready file is missing");
	return { ok: failures.length === 0, failures };
}
