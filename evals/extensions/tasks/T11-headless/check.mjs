import { check as checkT1 } from "../T1-background-server/check.mjs";

export async function check(ctx) {
	const result = await checkT1(ctx);
	const failures = [...result.failures];
	if (ctx.mode === "deterministic" && !ctx.headless) failures.push("T11 must run with no ui");
	for (const item of ctx.trace.uiExceptions) failures.push(`ui (${item.where}): ${item.message}`);
	if (ctx.trace.crashes.some((item) => /pi-tui|ui/.test(`${item.message} ${item.stack ?? ""}`))) {
		failures.push("uncaught ui or pi-tui exception");
	}
	return { ok: failures.length === 0, failures };
}
