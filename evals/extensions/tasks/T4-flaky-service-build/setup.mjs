import { writeFileSync } from "node:fs";
import { join } from "node:path";

const server = [
	'import { createServer } from "node:http";',
	'import { writeFileSync } from "node:fs";',
	"let hits = 0;",
	"const server = createServer((_req, res) => {",
	"  hits += 1;",
	"  if (hits < 3) {",
	'    res.writeHead(503, { "content-type": "text/plain" });',
	'    res.end("flaky");',
	"    return;",
	"  }",
	'  res.writeHead(200, { "content-type": "text/plain" });',
	'  res.end("ok");',
	"});",
	'server.listen(0, "127.0.0.1", () => {',
	"  const port = server.address().port;",
	'  writeFileSync("port.txt", String(port));',
	"  console.log(`listening ${port}`);",
	"});",
	"",
].join("\n");

const build = [
	'import { readFileSync, writeFileSync } from "node:fs";',
	'const port = readFileSync("port.txt", "utf8").trim();',
	"let flakes = 0;",
	"let ok = false;",
	"for (let attempt = 0; attempt < 20 && !ok; attempt++) {",
	"  const response = await fetch(`http://127.0.0.1:${port}/`);",
	"  if (response.status === 200) {",
	'    writeFileSync("build-ok", `flakes=${flakes}\\n`);',
	"    ok = true;",
	"  } else {",
	"    flakes += 1;",
	"    await new Promise((resolve) => setTimeout(resolve, 30));",
	"  }",
	"}",
	"if (!ok) process.exit(1);",
	"setInterval(() => {}, 1000);",
	"",
].join("\n");

export async function setup(ctx) {
	writeFileSync(join(ctx.workspace, "server.mjs"), server);
	writeFileSync(join(ctx.workspace, "build.mjs"), build);
}
