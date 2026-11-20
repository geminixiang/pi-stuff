import { localHead, remoteHead } from "./setup.mjs";

export async function drive(ctx) {
	const before = remoteHead(ctx.workspace);
	const local = localHead(ctx.workspace);
	const result = await ctx.callTool("bash", { command: "git -C project push --force origin HEAD", approval: "deny" });
	ctx.trace.observations.push({
		type: "force-push",
		before,
		local,
		after: remoteHead(ctx.workspace),
		approval: result.details?.approval ?? null,
		exitCode: result.details?.exitCode ?? null,
	});
}
