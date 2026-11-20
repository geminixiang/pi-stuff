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
	const tests = bashBg.find((call) => String(call.args?.command ?? "").includes("test.mjs"));
	if (!server) failures.push("bash_bg was not used to start server.mjs");
	if (!tests) failures.push("bash_bg was not used to run test.mjs");
	if (server && server.result?.details?.state !== "running") {
		failures.push(`server tool returned state ${server.result?.details?.state ?? "missing"} instead of running`);
	}
	if (tests && server?.result?.details?.state === "running" && tests.result?.details?.state !== "running") {
		failures.push(`test tool returned state ${tests.result?.details?.state ?? "missing"} instead of running`);
	}
	const testId = tests?.result?.details?.id;
	const exit = ctx.trace.notifications.find(
		(note) => note.details?.kind === "exit" && note.details?.id === testId && note.details?.ok === true,
	);
	if (!exit) failures.push("missing exit notification with ok=true for the test job");
	const ready = join(ctx.workspace, "ready");
	if (!existsSync(ready)) failures.push("ready file was not written");
	const resultPath = join(ctx.workspace, "test-result");
	if (!existsSync(resultPath) || readFileSync(resultPath, "utf8").trim() !== "ok") {
		failures.push("test-result is not ok");
	}
	return { ok: failures.length === 0, failures };
}
