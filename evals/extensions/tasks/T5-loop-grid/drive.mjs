import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scoreLoopGrid } from "../../harness/loop-grid.mjs";

const INTERVAL = 60_000;

function loopNotes(trace) {
	return trace.notifications.filter((note) => note.source === "sendUserMessage" && note.text.includes("[loop "));
}

function pull(ctx, into, seen) {
	const notes = loopNotes(ctx.trace);
	const status = readFileSync(join(ctx.workspace, "status.txt"), "utf8").trim();
	while (seen.count < notes.length) {
		const note = notes[seen.count];
		seen.count += 1;
		into.push({ at: note.at, status, run: Number(/run #(\d+)/.exec(note.text)?.[1] ?? 0) });
	}
}

export async function drive(ctx) {
	const steady = [];
	const sleepFires = [];
	const after = [];
	const seen = { count: 0 };
	await ctx.callTool("loop_create", {
		prompt: "Read status.txt and report its contents. When it says READY, the watch is done.",
		interval: "1m",
	});
	await ctx.clock.tick(1);
	pull(ctx, steady, seen);
	for (let i = 0; i < 3; i++) {
		await ctx.endTurn();
		await ctx.clock.tick(INTERVAL);
		pull(ctx, steady, seen);
	}
	await ctx.endTurn();
	await ctx.clock.tick(10 * INTERVAL);
	pull(ctx, sleepFires, seen);
	writeFileSync(join(ctx.workspace, "status.txt"), "READY\n");
	await ctx.endTurn();
	await ctx.clock.tick(INTERVAL);
	pull(ctx, after, seen);
	const grid = scoreLoopGrid(steady.map((fire) => fire.at), INTERVAL);
	ctx.trace.loopGrid = {
		intervalMs: INTERVAL,
		...grid,
		sleepFires: sleepFires.length,
		readyStatus: after.at(-1)?.status ?? null,
		fires: [...steady, ...sleepFires, ...after],
	};
}
