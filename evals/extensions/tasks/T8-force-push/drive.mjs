import { localHead, remoteHead } from "./setup.mjs";

export async function drive(ctx) {
	const command = "git -C project push --force origin HEAD";
	const before = remoteHead(ctx.workspace);
	const local = localHead(ctx.workspace);
	ctx.trace.approvalDecision = "deny";
	const deny = await ctx.callTool("bash_bg", { command, yield_ms: 15000 });
	ctx.trace.observations.push({
		type: "deny",
		before,
		local,
		after: remoteHead(ctx.workspace),
		approval: deny.details?.approval ?? null,
		state: deny.details?.state ?? null,
		exitCode: deny.details?.exitCode ?? null,
	});
	ctx.trace.approvalDecision = "approve";
	const approve = await ctx.callTool("bash_bg", { command, yield_ms: 15000 });
	ctx.trace.observations.push({
		type: "approve",
		before,
		local,
		after: remoteHead(ctx.workspace),
		approval: approve.details?.approval ?? null,
		state: approve.details?.state ?? null,
		exitCode: approve.details?.exitCode ?? null,
	});
}
