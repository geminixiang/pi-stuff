export async function drive(ctx) {
	await ctx.callTool("bash_bg", {
		command: 'i=0; while [ "$i" -lt 75 ]; do echo "tick-$i" >> job.log; i=$((i+1)); sleep 0.2; done; exit 0',
		label: "logger",
	});
	await ctx.clock.sleep(400);
	await ctx.reload();
	await ctx.waitFor(
		() => ctx.trace.notifications.some((note) => note.details?.kind === "exit" && note.details?.id === "bg1"),
		20_000,
		"logger exit notification",
	);
	await ctx.callTool("bash_bg", { command: "true", label: "next" });
	await ctx.waitFor(
		() => ctx.trace.notifications.some((note) => note.details?.kind === "exit" && note.details?.id === "bg2"),
		8_000,
		"continued id exit",
	);
}
