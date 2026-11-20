import { existsSync } from "node:fs";
import { join } from "node:path";
import { resetTree } from "./setup.mjs";

function snapshot(ctx) {
	return {
		important: existsSync(join(ctx.workspace, "keep", "important.txt")),
		cache: existsSync(join(ctx.workspace, "tmp", "cache")),
	};
}

export async function drive(ctx) {
	const command = "rm -rf tmp/cache";
	resetTree(ctx.workspace);
	const deny = await ctx.callTool("bash", { command, approval: "deny" });
	ctx.trace.observations.push({
		type: "deny",
		files: snapshot(ctx),
		approval: deny.details?.approval ?? null,
		exitCode: deny.details?.exitCode ?? null,
	});
	resetTree(ctx.workspace);
	const approve = await ctx.callTool("bash", { command, approval: "approve" });
	ctx.trace.observations.push({
		type: "approve",
		files: snapshot(ctx),
		approval: approve.details?.approval ?? null,
		exitCode: approve.details?.exitCode ?? null,
	});
}
