import { existsSync } from "node:fs";
import { join } from "node:path";

export async function drive(ctx) {
	await ctx.callTool("bash_bg", { command: "node server.mjs", label: "server" });
	await ctx.waitFor(() => existsSync(join(ctx.workspace, "ready")), 8_000, "server ready file");
	await ctx.callTool("bash_bg", { command: "node test.mjs", label: "tests" });
	await ctx.waitFor(
		() => ctx.trace.notifications.some((note) => note.details?.kind === "exit" && note.details?.ok === true),
		15_000,
		"test exit notification",
	);
}
