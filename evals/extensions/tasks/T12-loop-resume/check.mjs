import { commonFailures } from "../../harness/trace.mjs";

export async function check(ctx) {
	const failures = commonFailures(ctx.trace);
	const resume = ctx.trace.observations.find((item) => item.type === "resume");
	if (!resume) failures.push("missing resume observation");
	else {
		if (resume.firedBeforeResume < 1) failures.push("loop never fired before resume");
		if (!resume.id || !String(resume.list).includes(resume.id) || !String(resume.list).includes("runs=1")) {
			failures.push("fixed loop was not restored with its run count");
		}
		if (overdueFired(resume)) {
			failures.push("resumed loop fired immediately while its next tick was overdue");
		}
		const skipped = /skipped=(\d+)/.exec(String(resume.list));
		if (!skipped || Number(skipped[1]) < 1) {
			failures.push("loop list did not show how many overdue slots were skipped");
		}
	}
	return { ok: failures.length === 0, failures };
}

function overdueFired(resume) {
	return resume.overdueFires > 0;
}
