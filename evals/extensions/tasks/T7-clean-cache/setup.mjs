import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function writeTree(workspace) {
	mkdirSync(join(workspace, "keep"), { recursive: true });
	mkdirSync(join(workspace, "tmp", "cache"), { recursive: true });
	writeFileSync(join(workspace, "keep", "important.txt"), "keep\n");
	writeFileSync(join(workspace, "tmp", "cache", "old.txt"), "cache\n");
}

export async function setup(ctx) {
	writeTree(ctx.workspace);
}

export function resetTree(workspace) {
	writeTree(workspace);
}
