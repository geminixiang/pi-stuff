import { writeFileSync } from "node:fs";
import { join } from "node:path";

const server = `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const server = createServer((req, res) => {
	if (req.url === "/health") {
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("ok\\n");
		return;
	}
	res.writeHead(404);
	res.end();
});
setTimeout(() => {
	server.listen(0, "127.0.0.1", () => {
		writeFileSync("ready", String(server.address().port));
	});
}, 1500);
`;

export async function setup(ctx) {
	writeFileSync(join(ctx.workspace, "server.mjs"), server);
}
