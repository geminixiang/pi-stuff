import { commonFailures } from "../../harness/trace.mjs";

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
		if (!/web search unavailable for local-gateway\/fake-model/i.test(text)) {
			failures.push(`search did not say web search is unavailable for local-gateway/fake-model: ${search.stderr.trim().slice(0, 240)}`);
		}
		if (search.gatewayHits !== 0) failures.push(`search called the gateway ${search.gatewayHits} time(s)`);
	}
	return { ok: failures.length === 0, failures };
}
