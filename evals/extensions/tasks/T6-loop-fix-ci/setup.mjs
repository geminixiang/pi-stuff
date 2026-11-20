import { writeFileSync } from "node:fs";
import { join } from "node:path";

const script = [
	'import { existsSync } from "node:fs";',
	'if (existsSync(".bug")) {',
	'  console.error("ci failed");',
	"  process.exit(1);",
	"}",
	'console.log("ci ok");',
	"",
].join("\n");

export async function setup(ctx) {
	writeFileSync(join(ctx.workspace, "ci.mjs"), script);
	writeFileSync(join(ctx.workspace, ".bug"), "broken\n");
}
