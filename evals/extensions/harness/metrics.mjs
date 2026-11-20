import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assessPolicy } from "./policy.mjs";
import { repoRoot } from "./paths.mjs";

export function loadTasks() {
	const root = join(repoRoot, "evals/extensions/tasks");
	return readdirSync(root)
		.filter((name) => name.startsWith("T"))
		.sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
		.map((name) => {
			const dir = join(root, name);
			const task = JSON.parse(readFileSync(join(dir, "task.json"), "utf8"));
			return { ...task, dir };
		});
}

export function expectedReason(task, mode) {
	const reason = task.expectedFail?.[mode];
	return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

export function summarizeRun(task, mode, repetition, result) {
	const trace = result.trace;
	const policy = assessPolicy(trace.toolCalls, task.toolPolicy ?? {});
	const toolErrors = trace.toolCalls.filter((call) => call.result?.isError || call.error).length;
	const failures = [...(result.outcome?.failures ?? [])];
	for (const item of trace.crashes) {
		const line = `crash (${item.where}): ${item.message}`;
		if (!failures.some((failure) => failure.includes(item.message))) failures.push(line);
	}
	for (const item of trace.uiExceptions) {
		const line = `ui (${item.where}): ${item.message}`;
		if (!failures.some((failure) => failure.includes(item.message))) failures.push(line);
	}
	const passed = failures.length === 0;
	const expected = expectedReason(task, mode);
	let status = "fail";
	if (passed && !expected) status = "pass";
	else if (!passed && expected) status = "expected-fail";
	else if (passed && expected) status = "unexpected-pass";
	return {
		id: task.id,
		title: task.title,
		mode,
		repetition,
		status,
		expectedFail: expected,
		success: passed,
		failures,
		crashes: trace.crashes.map((item) => ({ where: item.where, message: item.message })),
		uiExceptions: trace.uiExceptions.map((item) => ({ where: item.where, message: item.message })),
		toolErrors,
		wrongTool: policy.wrongTool,
		wrongToolCalls: policy.wrongToolCalls,
		notificationCount: trace.notifications.length,
		wallTimeMs: result.wallTimeMs,
		tokens: mode === "live" ? trace.tokens : null,
		loopGrid: trace.loopGrid ?? null,
		observations: trace.observations,
		tools: trace.toolCalls.map((call) => ({
			name: call.name,
			command: call.args?.command,
			wait_until: call.args?.wait_until,
			notify_on: call.args?.notify_on,
			state: call.result?.details?.state,
			id: call.result?.details?.id,
			isError: Boolean(call.result?.isError || call.error),
			durationMs: call.durationMs,
		})),
	};
}

export function passAt(runs) {
	const byTask = new Map();
	for (const run of runs) {
		const bucket = byTask.get(run.id) ?? [];
		bucket.push(run);
		byTask.set(run.id, bucket);
	}
	const report = {};
	for (const [id, bucket] of byTask) {
		const n = bucket.length;
		const c = bucket.filter((run) => run.success).length;
		const ks = {};
		for (let k = 1; k <= n; k++) ks[`passAt${k}`] = estimatePassAtK(n, c, k);
		report[id] = { n, c, ...ks };
	}
	return report;
}

function estimatePassAtK(n, c, k) {
	if (k > n) return null;
	if (n - c < k) return 1;
	let numerator = 1;
	let denominator = 1;
	for (let i = 0; i < k; i++) {
		numerator *= n - c - i;
		denominator *= n - i;
	}
	return 1 - numerator / denominator;
}

export function gitSha() {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
	} catch {
		return null;
	}
}

export function writeSummary(summary) {
	const root = join(repoRoot, "evals/extensions/results");
	const dir = join(root, summary.id);
	mkdirSync(dir, { recursive: true });
	const text = `${JSON.stringify(summary, null, 2)}\n`;
	writeFileSync(join(dir, "summary.json"), text);
	writeFileSync(join(root, `latest-${summary.mode}.json`), text);
	return join(dir, "summary.json");
}

export function suiteFailed(summary) {
	if (summary.smoke && summary.smoke.ok === false) return true;
	return summary.runs.some((run) => run.status === "fail");
}
