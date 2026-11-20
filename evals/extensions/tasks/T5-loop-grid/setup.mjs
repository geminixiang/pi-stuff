import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function setup(ctx) {
	writeFileSync(join(ctx.workspace, "status.txt"), "PENDING\n");
}
