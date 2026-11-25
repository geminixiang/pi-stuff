#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./harness/paths.mjs";

const start = "<!-- BASELINE:START -->";
const end = "<!-- BASELINE:END -->";

function seconds(ms) {
	if (ms == null) return "";
	return `${(ms / 1000).toFixed(1)}s`;
}

function noteFor(run) {
	const parts = [];
	if (run.loopGrid) {
		parts.push(
			`drift ${run.loopGrid.driftMs}ms, missed ${run.loopGrid.missed}, duplicates ${run.loopGrid.duplicates}, sleepFires ${run.loopGrid.sleepFires ?? ""}`.trim(),
		);
	}
	if (run.expectedFail && run.status === "expected-fail") parts.push(run.expectedFail);
	const known = (run.failures ?? []).filter((failure) => failure.startsWith("expected: "));
	if (known.length && run.status !== "expected-fail") parts.push(known.join("; "));
	return parts.join(". ");
}

export function renderBaseline(summary) {
	const header = [
		"Task",
		"Status",
		"Wall",
		"Notifications",
		"Wrong tool",
		"Tool errors",
		"Crashes",
		"UI",
		"Approval",
		"Unsafe",
		"pass@1",
		"Notes",
	];
	const rows = [header, header.map(() => "---")];
	const smoke = summary.smoke?.ok ? "pass" : summary.smoke ? "fail" : "not run";
	rows.push(["smoke rpc", smoke, "", "", "", "", "", "", "", "", "", ""]);
	const skipped = new Map((summary.skippedTasks ?? []).map((item) => [item.id, item.reason]));
	const byId = new Map();
	for (const run of summary.runs ?? []) if (!byId.has(run.id)) byId.set(run.id, run);
	const ids = [...new Set([...byId.keys(), ...skipped.keys()])].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
	for (const id of ids) {
		const run = byId.get(id);
		if (!run) {
			rows.push([id, "skipped", "", "", "", "", "", "", "", "", "", skipped.get(id) ?? ""]);
			continue;
		}
		const pass = summary.passAt?.[run.id];
		const approval = run.approvalOutcomes
			? `${run.approvalRequests} requested, ${run.approvalOutcomes.unavailable ?? 0} unavailable`
			: "";
		rows.push([
			run.id,
			run.status,
			seconds(run.wallTimeMs),
			String(run.notificationCount ?? ""),
			String(run.wrongTool ?? ""),
			String(run.toolErrors ?? ""),
			String(run.crashes?.length ?? 0),
			String(run.uiExceptions?.length ?? 0),
			approval,
			String(run.unsafeCommandsExecuted?.length ?? 0),
			pass ? String(pass.passAt1) : "",
			noteFor(run).replaceAll("|", "/"),
		]);
	}
	const table = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
	return [
		`Recorded by \`node evals/extensions/baseline.mjs\` against \`${summary.gitSha ?? "unknown"}\`. Deterministic repetitions = ${summary.repetitions}. This harness does not change extension code.`,
		"",
		table,
		"",
		"T5, T6, and T12 use the fake clock and are skipped in live mode. T10 runs only when `ANTHROPIC_API_KEY` is set.",
	].join("\n");
}

function writeMarked(path, markdown) {
	const current = readFileSync(path, "utf8");
	if (!current.includes(start) || !current.includes(end)) {
		throw new Error(`${path} is missing ${start} / ${end}`);
	}
	const next = current.replace(new RegExp(`${start}[\\s\\S]*?${end}`), `${start}\n${markdown}\n${end}`);
	writeFileSync(path, next);
}

const run = spawnSync(process.execPath, [join(repoRoot, "evals/extensions/run.mjs"), "--mode", "deterministic"], {
	cwd: repoRoot,
	stdio: "inherit",
});
const summaryPath = join(repoRoot, "evals/extensions/results/latest-deterministic.json");
const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const markdown = renderBaseline(summary);
writeMarked(join(repoRoot, "evals/extensions/README.md"), markdown);
console.log("updated evals/extensions/README.md baseline");
process.exit(run.status ?? 1);
