import { spawn } from "node:child_process";
import { unlinkSync } from "node:fs";
import { join } from "node:path";

const INTERVAL = 60_000;

function loopCount(trace) {
	return trace.notifications.filter((note) => note.source === "sendUserMessage" && note.text.includes("[loop ")).length;
}

function runCi(workspace) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["ci.mjs"], { cwd: workspace });
		let out = "";
		child.stdout?.on("data", (chunk) => {
			out += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk) => {
			out += chunk.toString("utf8");
		});
		child.on("close", (code) => resolve({ code, out }));
	});
}

export async function drive(ctx) {
	await ctx.callTool("loop_create", {
		prompt: "Run node ci.mjs. If it fails, remove .bug and run it once more. Do not fix it more than once.",
		interval: "1m",
	});
	await ctx.clock.tick(1);
	if (loopCount(ctx.trace) < 1) throw new Error("loop did not fire");
	const exits = [];
	let fixes = 0;
	const first = await runCi(ctx.workspace);
	exits.push(first.code);
	if (first.code !== 0 && fixes < 1) {
		fixes += 1;
		unlinkSync(join(ctx.workspace, ".bug"));
		const again = await runCi(ctx.workspace);
		exits.push(again.code);
	}
	const during = loopCount(ctx.trace);
	await ctx.clock.tick(5 * INTERVAL);
	const reentered = loopCount(ctx.trace) > during;
	await ctx.endTurn();
	ctx.trace.observations.push({ type: "ci-fix", fixes, exits, reentered });
}
