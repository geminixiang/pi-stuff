/**
 * pi-loop — session-scoped recurring prompts, modeled on Claude Code's /loop.
 *
 *   /loop 5m check whether the deploy finished    fixed interval
 *   /loop check CI and fix failures               self-paced (agent picks next delay via loop_next)
 *   /loop                                         self-paced maintenance prompt (.pi/loop.md, ~/.pi/agent/loop.md)
 *   /loop list | /loop stop [id|all]
 *
 * Jobs fire only while pi runs and the agent is idle; missed ticks are not replayed.
 * Fixed jobs are persisted to the session and restored on resume; self-paced ones are not.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_JOBS = 50;
const EXPIRE_MS = 7 * 24 * 3600_000;
const MIN_MS = 60_000;
const DYN_MIN_MS = 60_000;
const DYN_MAX_MS = 3600_000;
const DYN_DEFAULT_MS = 10 * 60_000;
/** Delay after agent_end before re-checking, so queued follow-ups can start first. */
const SETTLE_MS = 2000;
/** Max single setTimeout span; guards against clock drift / sleep. */
const MAX_WAIT_MS = 30 * 60_000;
/** Coarse re-check if a timer finds the agent busy or errors. Only runs while a job is due. */
const BUSY_RETRY_MS = 60_000;
/** Minimum gap after a loop run that overran its own interval. */
const OVERRUN_GAP_MS = 5 * 60_000;
const ENTRY = "pi-loop:jobs";

const DEFAULT_PROMPT =
	"Loop maintenance check: review the current task state (CI, pending work, open issues in this session). " +
	"Do the next useful step if there is one; otherwise report briefly that nothing needs attention.";

interface Job {
	id: string;
	prompt: string;
	intervalMs?: number; // undefined => self-paced
	nextAt: number;
	createdAt: number;
	runs: number;
	expiring?: boolean;
}

export function parseDuration(s: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i.exec(s.trim());
	if (!m) return undefined;
	const n = Number(m[1]);
	const u = m[2].toLowerCase()[0];
	const mult = u === "s" ? 1000 : u === "m" ? 60_000 : u === "h" ? 3600_000 : 86_400_000;
	return n * mult;
}

/** Split "/loop" args into interval + prompt. Accepts "5m ...", "every 2 hours ...", "... every 5m". */
export function parseLoopArgs(raw: string): { intervalMs?: number; prompt: string } {
	let text = raw.trim();
	let intervalMs: number | undefined;
	const lead = /^(?:every\s+)?(\d+(?:\.\d+)?\s*[a-z]+)\b\s*/i.exec(text);
	if (lead && parseDuration(lead[1]) !== undefined) {
		intervalMs = parseDuration(lead[1]);
		text = text.slice(lead[0].length);
	} else {
		const tail = /\s+every\s+(\d+(?:\.\d+)?\s*[a-z]+)\s*$/i.exec(text);
		if (tail && parseDuration(tail[1]) !== undefined) {
			intervalMs = parseDuration(tail[1]);
			text = text.slice(0, tail.index);
		}
	}
	if (intervalMs !== undefined) intervalMs = Math.max(MIN_MS, Math.ceil(intervalMs / 60_000) * 60_000);
	return { intervalMs, prompt: text.trim() };
}

function fmt(ms: number): string {
	if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
	if (ms % 3600_000 === 0) return `${ms / 3600_000}h`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	return `${Math.round(ms / 1000)}s`;
}

function loadDefaultPrompt(cwd: string): string {
	for (const p of [join(cwd, ".pi", "loop.md"), join(homedir(), ".pi", "agent", "loop.md")]) {
		try {
			if (existsSync(p)) {
				const t = readFileSync(p, "utf8").trim();
				if (t) return t;
			}
		} catch {}
	}
	return DEFAULT_PROMPT;
}

export function refineRequest(prompt: string, interval: string | undefined): string {
	return [
		`[pi-loop] The user wants to schedule a recurring prompt${interval ? ` every ${interval}` : " (self-paced)"}:`,
		"",
		"<user_prompt>",
		prompt,
		"</user_prompt>",
		"",
		"Rewrite it into a prompt that will be re-sent on each run, then call loop_create with it" +
			(interval ? ` and interval "${interval}"` : " and no interval") +
			". Do NOT execute the task now.",
		"The rewritten prompt must:",
		"- Be self-contained: later runs may happen after compaction, so inline the concrete specifics from this conversation (repo, branch, PR/issue numbers, commands, URLs, file paths).",
		"- State what to check and how (exact commands where possible).",
		"- Define the done condition, and what to do when it is met (" +
			(interval ? "report and suggest stopping the loop with loop_delete" : "call loop_next with stop: true") +
			").",
		"- Say to keep the report short when nothing changed, and to not repeat earlier findings.",
		"- Keep the user's intent; don't add scope. Write in the user's language.",
		"If the request is too ambiguous to rewrite safely, ask one short question instead of calling loop_create.",
		"After creating it, show the final prompt to the user in one short block.",
	].join("\n");
}

export function editRequest(id: string, feedback: string): string {
	return [
		`[pi-loop] Improve loop ${id}.`,
		feedback ? `User feedback: ${feedback}` : "No specific feedback: judge from its past runs in this conversation.",
		"",
		`1. Call loop_list with id "${id}" to read the current prompt.`,
		`2. Review this conversation's earlier "[loop ${id} ...]" runs: what was wasted, noisy, missed, repeated, or ambiguous; whether the done condition and interval fit.`,
		"3. Call loop_update with the full revised prompt (and interval only if it should change). Keep it self-contained and keep the user's intent.",
		"Do NOT execute the loop task now. Then show a short before→after of what changed and why.",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	let jobs: Job[] = [];
	let ctxRef: ExtensionContext | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let seq = 0;
	let lastFiredId: string | undefined;
	/** Self-paced job whose prompt is currently running (loop_next targets it). */
	let activeDynamicId: string | undefined;

	const newId = () => `L${(++seq).toString(36)}${Date.now().toString(36).slice(-3)}`;

	const persist = () => {
		const fixed = jobs.filter((j) => j.intervalMs !== undefined);
		pi.appendEntry(ENTRY, { jobs: fixed });
	};

	const updateStatus = () => {
		const ui = ctxRef?.ui;
		if (!ui) return;
		if (!jobs.length) return ui.setStatus("pi-loop", undefined);
		// Absolute time, so the status needs no periodic refresh.
		const next = new Date(Math.min(...jobs.map((j) => j.nextAt)));
		const hhmm = next.toTimeString().slice(0, 5);
		ui.setStatus("pi-loop", `⟳ ${jobs.length} loop${jobs.length > 1 ? "s" : ""} · next ${hhmm}`);
	};

	const describe = (j: Job) => {
		const when = j.intervalMs ? `every ${fmt(j.intervalMs)}` : "self-paced";
		const inS = Math.max(0, Math.round((j.nextAt - Date.now()) / 1000));
		const p = j.prompt.length > 60 ? `${j.prompt.slice(0, 57)}...` : j.prompt;
		return `${j.id}  ${when}  next in ${inS}s  runs=${j.runs}  ${p}`;
	};

	const add = (prompt: string, intervalMs: number | undefined): Job | string => {
		if (jobs.length >= MAX_JOBS) return `Too many loops (max ${MAX_JOBS}).`;
		const now = Date.now();
		const job: Job = { id: newId(), prompt, intervalMs, createdAt: now, nextAt: now, runs: 0 };
		jobs.push(job);
		if (intervalMs !== undefined) persist();
		schedule();
		return job;
	};

	const remove = (id: string): boolean => {
		const before = jobs.length;
		const wasFixed = jobs.some((j) => j.id === id && j.intervalMs !== undefined);
		jobs = id === "all" ? [] : jobs.filter((j) => j.id !== id);
		if (activeDynamicId && !jobs.some((j) => j.id === activeDynamicId)) activeDynamicId = undefined;
		if (wasFixed || id === "all") persist();
		schedule();
		return jobs.length !== before;
	};

	const fire = (job: Job) => {
		const now = Date.now();
		job.runs++;
		const expired = now - job.createdAt >= EXPIRE_MS;
		const header = job.intervalMs
			? `[loop ${job.id} · every ${fmt(job.intervalMs)} · run #${job.runs}${expired ? " · final run (expired)" : ""}]`
			: `[loop ${job.id} · self-paced · run #${job.runs}] When done, call loop_next with id "${job.id}" and a delay (1m–60m) based on what you saw, or stop: true if the loop's goal is complete.`;
		if (expired) {
			jobs = jobs.filter((j) => j.id !== job.id);
			persist();
		} else if (job.intervalMs) {
			job.nextAt = now + job.intervalMs; // no catch-up
			persist();
		} else {
			// Fallback pacing if the agent forgets to call loop_next.
			job.nextAt = now + DYN_DEFAULT_MS;
			activeDynamicId = job.id;
		}
		lastFiredId = job.id;
		pi.sendUserMessage(`${header}\n\n${job.prompt}`);
		schedule();
	};

	/**
	 * Event-driven: one setTimeout armed for the earliest due job. No polling.
	 * If the agent is busy when it fires, we simply wait — agent_end re-arms us.
	 */
	const check = () => {
		timer = undefined;
		const ctx = ctxRef;
		if (!ctx) return;
		try {
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				// Normally agent_end re-arms us. Safety net in case busy state ends without
				// agent_end (e.g. compaction, queued message drained elsewhere): one coarse retry.
				return schedule(BUSY_RETRY_MS);
			}
			const due = jobs.filter((j) => j.nextAt <= Date.now()).sort((a, b) => a.nextAt - b.nextAt)[0];
			if (due) fire(due); // one per idle window; fire() re-schedules
			else schedule();
		} catch (err) {
			// A throw inside a timer callback is uncaught and could take pi down. Never let it.
			console.error("[pi-loop]", err);
			schedule(BUSY_RETRY_MS);
		}
	};

	const schedule = (minDelay = 0) => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		updateStatus();
		if (!jobs.length) return;
		const next = Math.min(...jobs.map((j) => j.nextAt));
		const wait = Math.min(MAX_WAIT_MS, Math.max(minDelay, next - Date.now()));
		timer = setTimeout(check, wait);
		timer.unref?.();
	};

	const restore = (ctx: ExtensionContext) => {
		ctxRef = ctx;
		jobs = [];
		activeDynamicId = undefined;
		let latest: Job[] | undefined;
		for (const e of ctx.sessionManager.getBranch() as any[]) {
			if (e.type === "custom" && e.customType === ENTRY) latest = e.data?.jobs;
		}
		const now = Date.now();
		for (const j of latest ?? []) {
			if (!j.intervalMs || now - j.createdAt >= EXPIRE_MS) continue;
			jobs.push({ ...j, nextAt: Math.max(j.nextAt, now) });
		}
		schedule();
	};

	pi.on("session_start", async (_e, ctx) => restore(ctx));
	pi.on("session_tree", async (_e, ctx) => restore(ctx));
	pi.on("agent_end", async (_e, ctx) => {
		ctxRef = ctx;
		// If a loop's own run outlasted its interval, don't fire it again back-to-back:
		// the next run is at least one interval after this one ended (keeps the user a window).
		const last = jobs.find((j) => j.id === lastFiredId);
		lastFiredId = undefined;
		if (last?.intervalMs) {
			last.nextAt = Math.max(last.nextAt, Date.now() + Math.min(last.intervalMs, OVERRUN_GAP_MS));
			persist();
		}
		schedule(SETTLE_MS); // catch jobs that came due while busy
	});
	pi.on("session_shutdown", async () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		jobs = [];
		const ui = ctxRef?.ui;
		ctxRef = undefined; // stale ctx must not be used by a late callback
		ui?.setStatus("pi-loop", undefined);
	});

	pi.registerCommand("loop", {
		description:
			"Run a prompt on a recurring interval (the agent refines it first): /loop [--raw] [5m|every 2h] <prompt> | edit [id] [feedback] | list | stop [id|all]",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const raw = (args ?? "").trim();
			const [head, ...rest] = raw.split(/\s+/);
			if (head === "list" || head === "ls") {
				ctx.ui.notify(jobs.length ? jobs.map(describe).join("\n") : "No loops.", "info");
				return;
			}
			if (head === "edit" || head === "tune") {
				// /loop edit [id] <what to change> — agent revises the loop using what it saw in past runs.
				let [id, ...words] = rest;
				if (!jobs.some((j) => j.id === id)) {
					if (jobs.length !== 1) return ctx.ui.notify("Usage: /loop edit <id> [what to change]", "warning");
					words = rest;
					id = jobs[0].id;
				}
				pi.sendUserMessage(editRequest(id, words.join(" ")), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
				return;
			}
			if (head === "clear" || head === "stop" || head === "rm" || head === "cancel") {
				const id = head === "clear" ? "all" : rest[0] ?? (jobs.length === 1 ? jobs[0].id : "");
				if (!id) return ctx.ui.notify("Usage: /loop stop <id|all>", "warning");
				ctx.ui.notify(remove(id) ? `Stopped ${id}.` : `No loop ${id}.`, "info");
				return;
			}
			// --raw: schedule the prompt verbatim, skipping the refinement turn.
			const verbatim = head === "--raw";
			const { intervalMs, prompt } = parseLoopArgs(verbatim ? rest.join(" ") : raw);
			if (!verbatim && prompt) {
				// Spend one LLM turn turning the user's terse prompt into a self-contained one.
				// The agent sees the current conversation, then calls loop_create itself.
				const interval = intervalMs ? `${Math.ceil(intervalMs / 60_000)}m` : undefined;
				pi.sendUserMessage(refineRequest(prompt, interval), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
				return;
			}
			const r = add(prompt || loadDefaultPrompt(ctx.cwd), intervalMs);
			if (typeof r === "string") return ctx.ui.notify(r, "error");
			ctx.ui.notify(
				`Loop ${r.id} ${intervalMs ? `every ${fmt(intervalMs)}` : "self-paced"} — first run when idle. /loop stop ${r.id} to cancel.`,
				"info",
			);
		},
	});

	pi.registerTool({
		name: "loop_create",
		label: "Loop create",
		description:
			"Schedule a prompt to re-run in this session on a fixed interval (min 1m, rounded up to whole minutes) or self-paced (omit interval). Runs only when the agent is idle; expires after 7 days. To change an existing loop use loop_update, never loop_delete + loop_create.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Prompt to send each run" }),
			interval: Type.Optional(Type.String({ description: 'e.g. "5m", "2h", "1d". Omit for self-paced.' })),
		}),
		async execute(_id, params) {
			let ms: number | undefined;
			if (params.interval) {
				ms = parseDuration(params.interval);
				if (ms === undefined) throw new Error(`Bad interval: ${params.interval}`);
				ms = Math.max(MIN_MS, Math.ceil(ms / 60_000) * 60_000);
			}
			const r = add(params.prompt, ms);
			if (typeof r === "string") throw new Error(r);
			return { content: [{ type: "text", text: `Created ${describe(r)}` }], details: { id: r.id } };
		},
	});

	pi.registerTool({
		name: "loop_list",
		label: "Loop list",
		description: "List scheduled loops in this session. Pass id to get that loop's full prompt.",
		parameters: Type.Object({ id: Type.Optional(Type.String()) }),
		async execute(_id, params) {
			if (params?.id) {
				const j = jobs.find((x) => x.id === params.id);
				if (!j) throw new Error(`No loop ${params.id}`);
				return { content: [{ type: "text", text: `${describe(j)}\n\n<prompt>\n${j.prompt}\n</prompt>` }], details: {} };
			}
			return { content: [{ type: "text", text: jobs.length ? jobs.map(describe).join("\n") : "No loops." }], details: {} };
		},
	});

	pi.registerTool({
		name: "loop_update",
		label: "Loop update",
		description:
			"Revise an existing loop in place (keeps id, run count and 7-day expiry). Use when the user wants to improve a loop after seeing a few runs. Read the current prompt with loop_list(id) first and send the full new prompt, not a diff.",
		parameters: Type.Object({
			id: Type.String(),
			prompt: Type.Optional(Type.String({ description: "Full replacement prompt" })),
			interval: Type.Optional(Type.String({ description: 'New interval e.g. "15m"; "self" for self-paced' })),
		}),
		async execute(_id, params) {
			const j = jobs.find((x) => x.id === params.id);
			if (!j) throw new Error(`No loop ${params.id}`);
			if (params.prompt?.trim()) j.prompt = params.prompt.trim();
			if (params.interval) {
				if (params.interval === "self") j.intervalMs = undefined;
				else {
					const ms = parseDuration(params.interval);
					if (ms === undefined) throw new Error(`Bad interval: ${params.interval}`);
					j.intervalMs = Math.max(MIN_MS, Math.ceil(ms / 60_000) * 60_000);
					j.nextAt = Math.min(j.nextAt, Date.now() + j.intervalMs);
				}
			}
			persist(); // also drops it from persistence if it became self-paced
			schedule();
			return { content: [{ type: "text", text: `Updated ${describe(j)}` }], details: { id: j.id } };
		},
	});

	pi.registerTool({
		name: "loop_delete",
		label: "Loop delete",
		description: 'Cancel a loop by id, or "all". Only for stopping a loop; to change its prompt or interval use loop_update instead (keeps id, run count and expiry).',
		parameters: Type.Object({ id: Type.String() }),
		async execute(_id, params) {
			const ok = remove(params.id);
			return { content: [{ type: "text", text: ok ? `Deleted ${params.id}` : `No loop ${params.id}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "loop_next",
		label: "Loop next",
		description:
			"For a self-paced loop run: choose when the next run happens (1m–60m) based on what you observed, or stop the loop when its goal is done.",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Loop id (defaults to the currently running self-paced loop)" })),
			delay: Type.Optional(Type.String({ description: 'e.g. "2m", "30m"' })),
			stop: Type.Optional(Type.Boolean()),
			reason: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			const id = params.id ?? activeDynamicId;
			const job = jobs.find((j) => j.id === id);
			if (!job) throw new Error(`No loop ${id ?? "(none active)"}`);
			if (job.intervalMs) throw new Error(`${job.id} has a fixed interval; use loop_delete to stop it.`);
			if (params.stop) {
				remove(job.id);
				return { content: [{ type: "text", text: `Stopped ${job.id}.` }], details: {} };
			}
			const ms = params.delay ? parseDuration(params.delay) : DYN_DEFAULT_MS;
			if (ms === undefined) throw new Error(`Bad delay: ${params.delay}`);
			const clamped = Math.min(DYN_MAX_MS, Math.max(DYN_MIN_MS, ms));
			job.nextAt = Date.now() + clamped;
			schedule();
			return { content: [{ type: "text", text: `${job.id} next run in ${fmt(clamped)}.` }], details: {} };
		},
	});
}
