import { writeFileSync } from "node:fs";
import { join } from "node:path";

const server = `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const server = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/plain" });
	res.end("ok\\n");
});
server.listen(0, "127.0.0.1", () => {
	writeFileSync("ready", String(server.address().port));
});
`;

const test = `import { existsSync, writeFileSync } from "node:fs";

const deadline = Date.now() + 8_000;
while (!existsSync("ready")) {
	if (Date.now() > deadline) {
		writeFileSync("test-result", "missing-ready\\n");
		process.exit(2);
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
}
await new Promise((resolve) => setTimeout(resolve, 800));
writeFileSync("test-result", "ok\\n");
`;

export async function setup(ctx) {
	writeFileSync(join(ctx.workspace, "server.mjs"), server);
	writeFileSync(join(ctx.workspace, "test.mjs"), test);
}
