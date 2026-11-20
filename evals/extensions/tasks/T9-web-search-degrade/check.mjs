import { commonFailures } from "../../harness/trace.mjs";

const CLEAR = /web[_ ]search|native search|does not support search|search is not available|search is unavailable/i;

export async function check(ctx) {
	const failures = commonFailures(ctx.trace);
	const search = ctx.trace.observations.find((item) => item.type === "search");
	if (!search) failures.push("missing search observation");
	else {
		const text = `${search.stdout}\n${search.stderr}`;
		const citations = text.match(/https:\/\/[^\s)"']+/g) ?? [];
		if (search.code === 0) failures.push("search succeeded against a gateway with no web search");
		if (search.code == null || /uncaught|SyntaxError/.test(text)) failures.push("search crashed");
		if (citations.length) failures.push(`fabricated citations: ${citations.join(" ")}`);
		if (!CLEAR.test(text)) failures.push(`expected: search error is vague: ${search.stderr.trim().slice(0, 240)}`);
	}
	return { ok: failures.length === 0, failures };
}
