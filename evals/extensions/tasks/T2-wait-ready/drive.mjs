export async function drive(ctx) {
	await ctx.callTool("bash_bg", { command: "node server.mjs", label: "server" });
	const started = await ctx.callTool("bash_bg", {
		command: "port=$(cat ready 2>/dev/null); [ -n \"$port\" ] && curl -sf \"http://127.0.0.1:${port}/health\"",
		wait_until: true,
		interval: 1,
		max_wait: 20,
		label: "health",
	});
	const id = started.details?.id;
	await ctx.waitFor(
		() => ctx.trace.notifications.some((note) => note.details?.kind === "exit" && note.details?.id === id),
		25_000,
		"health exit notification",
	);
}
