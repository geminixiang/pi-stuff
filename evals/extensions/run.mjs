#!/usr/bin/env node
import { createTrace, serializeError } from "./harness/trace.mjs";
import { runDeterministic } from "./harness/deterministic.mjs";
import { hasLiveKey } from "./harness/extensions.mjs";
import { runLive } from "./harness/live.mjs";
import { gitSha, loadTasks, passAt, suiteFailed, summarizeRun, writeSummary } from "./harness/metrics.mjs";
import { createSandbox, disposeSandbox, pinProcessHome } from "./harness/sandbox.mjs";
import { smokeRpc } from "./harness/smoke.mjs";

const help = `Usage: node evals/extensions/run.mjs [--mode deterministic|live] [--task T1,T2] [--repetitions N] [--model provider/id] [--provider name] [--pi path] [--skip-smoke]

deterministic (default) scripts the extensions through a fake ExtensionAPI. No model.
live drives pi --mode rpc. It skips with exit 0 when no provider API key is set.
`;

function parseArgs(argv) {
	const opts = {
		mode: "deterministic",
		tasks: [],
		repetitions: undefined,
		model: undefined,
		provider: undefined,
		pi: undefined,
		skipSmoke: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") opts.help = true;
		else if (arg === "--mode") opts.mode = argv[++i];
		else if (arg === "--task") {
			const value = argv[++i] ?? "";
			opts.tasks.push(...value.split(",").map((part) => part.trim()).filter(Boolean));
		} else if (arg === "--repetitions") opts.repetitions = Number(argv[++i]);
		else if (arg === "--model") opts.model = argv[++i] || undefined;
		else if (arg === "--provider") opts.provider = argv[++i] || undefined;
		else if (arg === "--pi") opts.pi = argv[++i];
		else if (arg === "--skip-smoke") opts.skipSmoke = true;
		else throw new Error(`unknown argument ${arg}`);
	}
	if (opts.mode !== "deterministic" && opts.mode !== "live") throw new Error(`unknown mode ${opts.mode}`);
	if (opts.repetitions === undefined) opts.repetitions = opts.mode === "live" ? 3 : 1;
	if (!Number.isInteger(opts.repetitions) || opts.repetitions < 1) throw new Error("--repetitions must be a positive integer");
	return opts;
}

function selectTasks(opts) {
	const tasks = loadTasks();
	if (!opts.tasks.length) return tasks;
	const wanted = new Set(opts.tasks);
	const selected = tasks.filter((task) => wanted.has(task.id));
	const missing = [...wanted].filter((id) => !selected.some((task) => task.id === id));
	if (missing.length) throw new Error(`unknown task ${missing.join(", ")}`);
	return selected;
}

function printRuns(runs) {
	for (const run of runs) {
		const seconds = (run.wallTimeMs / 1000).toFixed(1);
		console.log(
			`${run.id}\t${run.status}\trep=${run.repetition}\t${seconds}s\tnotifications=${run.notificationCount}\twrongTool=${run.wrongTool}\ttoolErrors=${run.toolErrors}\tcrashes=${run.crashes.length}\tui=${run.uiExceptions.length}`,
		);
		for (const failure of run.failures) console.log(`  - ${failure}`);
	}
}

const suite = createSandbox("pi-eval-suite-");
pinProcessHome(suite);
let code = 1;
try {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log(help);
		code = 0;
	} else {
		const startedAt = new Date().toISOString();
		const summary = {
			id: `${startedAt.replace(/[:.]/g, "-")}-${opts.mode}`,
			mode: opts.mode,
			gitSha: gitSha(),
			startedAt,
			finishedAt: null,
			repetitions: opts.repetitions,
			model: opts.model ?? null,
			provider: opts.provider ?? null,
			skipped: false,
			skipReason: null,
			smoke: null,
			runs: [],
			passAt: {},
		};

		if (!opts.skipSmoke) {
			summary.smoke = await smokeRpc(opts.pi);
			console.log(summary.smoke.ok ? "smoke rpc: pass" : `smoke rpc: fail ${summary.smoke.errors.join("; ")}`);
		}

		if (opts.mode === "live" && !hasLiveKey()) {
			summary.skipped = true;
			summary.skipReason = "no provider API key in the environment; live tasks were not run";
			console.log(summary.skipReason);
		} else {
			const tasks = selectTasks(opts);
			for (const task of tasks) {
				for (let repetition = 1; repetition <= opts.repetitions; repetition++) {
					try {
						const result =
							opts.mode === "live"
								? await runLive(task, { piBin: opts.pi, model: opts.model, provider: opts.provider })
								: await runDeterministic(task);
						summary.runs.push(summarizeRun(task, opts.mode, repetition, result));
					} catch (error) {
						const trace = createTrace({ mode: opts.mode, headless: Boolean(task.headless), taskId: task.id });
						trace.driveError = serializeError(error);
						summary.runs.push(
							summarizeRun(task, opts.mode, repetition, {
								trace,
								outcome: { ok: false, failures: [`runner: ${trace.driveError.message}`] },
								wallTimeMs: 0,
							}),
						);
					}
				}
			}
			summary.passAt = passAt(summary.runs);
		}

		summary.finishedAt = new Date().toISOString();
		const file = writeSummary(summary);
		printRuns(summary.runs);
		console.log(`wrote ${file}`);
		code = suiteFailed(summary) ? 1 : 0;
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	code = 1;
} finally {
	disposeSandbox(suite);
}
process.exit(code);
