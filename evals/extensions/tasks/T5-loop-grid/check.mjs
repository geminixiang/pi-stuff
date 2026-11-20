import { commonFailures } from "../../harness/trace.mjs";

export async function check(ctx) {
	const failures = commonFailures(ctx.trace);
	const grid = ctx.trace.loopGrid;
	if (!grid) failures.push("missing loop grid");
	else {
		if (grid.driftMs !== 0) failures.push(`grid drift ${grid.driftMs}ms`);
		if (grid.missed !== 0) failures.push(`missed ${grid.missed} grid slots`);
		if (grid.duplicates !== 0) failures.push(`duplicate runs ${grid.duplicates}`);
		if (grid.sleepFires !== 1) failures.push(`sleep jump fired ${grid.sleepFires} times`);
		if (grid.readyStatus !== "READY") failures.push(`next tick after READY saw ${grid.readyStatus}`);
		const steady = (grid.fires ?? []).filter((fire) => fire.status === "PENDING");
		if (steady.length < 4) failures.push(`expected at least 4 PENDING ticks, saw ${steady.length}`);
	}
	return { ok: failures.length === 0, failures };
}
