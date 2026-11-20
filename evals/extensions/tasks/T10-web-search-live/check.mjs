import { commonFailures } from "../../harness/trace.mjs";

export async function check(ctx) {
	const failures = commonFailures(ctx.trace);
	const search = ctx.trace.observations.find((item) => item.type === "search");
	if (!search) failures.push("missing search observation");
	else {
		const text = `${search.stdout}\n${search.stderr}`;
		if (search.code !== 0) failures.push(`search exited ${search.code}: ${search.stderr.trim().slice(0, 240)}`);
		if (!/https:\/\/[^\s)"']+/.test(text)) failures.push("output has no parseable https URL");
	}
	return { ok: failures.length === 0, failures };
}
