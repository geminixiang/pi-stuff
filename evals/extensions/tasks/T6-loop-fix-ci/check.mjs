import { commonFailures } from "../../harness/trace.mjs";

export async function check(ctx) {
	const failures = commonFailures(ctx.trace);
	const ci = ctx.trace.observations.find((item) => item.type === "ci-fix");
	if (!ci) failures.push("missing ci observation");
	else {
		if (ci.fixes !== 1) failures.push(`applied ${ci.fixes} fixes`);
		if (ci.exits.at(-1) !== 0) failures.push(`final exit was ${ci.exits.at(-1)}`);
		if (ci.reentered) failures.push("loop fired again while the fix was still running");
	}
	return { ok: failures.length === 0, failures };
}
