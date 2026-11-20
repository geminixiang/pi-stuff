const INTERVAL = 60_000;

function loopNotes(trace) {
	return trace.notifications.filter((note) => note.source === "sendUserMessage" && note.text.includes("[loop "));
}

export async function drive(ctx) {
	const created = await ctx.callTool("loop_create", {
		prompt: "Report whether the resumed watch should run.",
		interval: "1m",
	});
	await ctx.clock.tick(1);
	const fired = loopNotes(ctx.trace).length;
	await ctx.endTurn();
	await ctx.suspend("resume");
	await ctx.clock.tick(10 * INTERVAL);
	await ctx.boot();
	const restored = await ctx.callTool("loop_list", {});
	const notesBefore = loopNotes(ctx.trace).length;
	await ctx.clock.tick(1);
	const overdueFires = loopNotes(ctx.trace).length - notesBefore;
	ctx.trace.observations.push({
		type: "resume",
		id: created.details?.id ?? null,
		firedBeforeResume: fired,
		list: restored.text,
		overdueFires,
	});
}
