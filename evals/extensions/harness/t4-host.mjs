import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSession } from "./session.mjs";
import { createTrace } from "./trace.mjs";
import { readJobs } from "./jobs.mjs";

const workspace = process.env.EVAL_WORKSPACE;
const statusPath = process.env.EVAL_STATUS;
if (!workspace || !statusPath) {
	console.error("EVAL_WORKSPACE and EVAL_STATUS are required");
	process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(path, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
		await sleep(30);
	}
	return readFileSync(path, "utf8").trim();
}

const trace = createTrace({ mode: "deterministic", headless: false, taskId: "T4-host" });
try {
	const session = await openSession({
		workspace,
		trace,
		headless: false,
		sessionId: "eval-T4-host",
		extensions: ["pi-bg-bash", "pi-supervisor"],
	});
	await session.start();
	const started = await session.callTool("supervisor_start", {
		command: process.execPath,
		args: [join(workspace, "server.mjs")],
		cwd: workspace,
		name: "flaky-http",
		readiness: { type: "output", substring: "listening" },
	});
	if (started.isError) throw new Error(started.text);
	const port = Number(await waitForFile(join(workspace, "port.txt"), 10_000));
	const build = await session.callTool("bash_bg", { command: "node build.mjs", label: "build" });
	if (build.isError) throw new Error(build.text);
	await waitForFile(join(workspace, "build-ok"), 10_000);
	const job = readJobs(process.env.PI_BG_BASH_DIR).jobs.find((item) => item.id === build.details?.id);
	writeFileSync(
		statusPath,
		`${JSON.stringify({
			ok: true,
			port,
			buildPid: job?.pid ?? null,
			buildId: build.details?.id ?? null,
		})}\n`,
	);
	setInterval(() => {}, 1_000);
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	writeFileSync(statusPath, `${JSON.stringify({ ok: false, error: message })}\n`);
	console.error(message);
	process.exit(1);
}
