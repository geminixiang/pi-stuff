import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { repoRoot } from "../../harness/paths.mjs";

const searchScript = join(repoRoot, "packages/pi-native-web-search/skills/native-web-search/search.mjs");

export async function setup() {}

export async function drive(ctx) {
	writeFileSync(
		join(ctx.paths.agentDir, "auth.json"),
		`${JSON.stringify({ anthropic: { type: "api_key", key: "$ANTHROPIC_API_KEY" } }, null, 2)}\n`,
	);
	const result = await new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[searchScript, "Node 24 LTS", "--purpose", "cite the official release URL", "--provider", "anthropic", "--timeout", "120000"],
			{
				cwd: ctx.workspace,
				env: { ...process.env, PI_CODING_AGENT_DIR: ctx.paths.agentDir, PI_PROVIDER: "anthropic" },
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
	ctx.trace.observations.push({ type: "search", ...result });
}
