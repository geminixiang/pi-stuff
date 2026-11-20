import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { repoRoot } from "../../harness/paths.mjs";

const searchScript = join(repoRoot, "packages/pi-native-web-search/skills/native-web-search/search.mjs");

function startGateway() {
	let hits = 0;
	const server = createServer((request, response) => {
		hits += 1;
		if (request.method === "POST" && request.url?.includes("/responses")) {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "Invalid request", type: "invalid_request_error" } }));
			return;
		}
		response.writeHead(404, { "content-type": "text/plain" });
		response.end("not found");
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			resolve({
				port,
				hits: () => hits,
				close: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

function runSearch(ctx) {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath,
			[searchScript, "Node 24 LTS", "--purpose", "cite the official release URL", "--provider", "local-gateway", "--model", "fake-model", "--timeout", "8000"],
			{
				cwd: ctx.workspace,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: ctx.paths.agentDir,
					PI_PROVIDER: "local-gateway",
					PI_MODEL: "fake-model",
				},
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
}

export async function drive(ctx) {
	const gateway = await startGateway();
	try {
		writeFileSync(
			join(ctx.paths.agentDir, "models.json"),
			`${JSON.stringify({
				providers: {
					"local-gateway": {
						baseUrl: `http://127.0.0.1:${gateway.port}/v1`,
						apiKey: "test-key",
						models: [{ id: "fake-model" }],
					},
				},
			}, null, 2)}\n`,
		);
		writeFileSync(
			join(ctx.paths.agentDir, "settings.json"),
			`${JSON.stringify({ defaultProvider: "local-gateway", defaultModel: "fake-model" }, null, 2)}\n`,
		);
		const result = await runSearch(ctx);
		ctx.trace.observations.push({ type: "search", gatewayHits: gateway.hits(), ...result });
	} finally {
		await gateway.close();
	}
}
