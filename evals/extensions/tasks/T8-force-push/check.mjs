import { commonFailures } from "../../harness/trace.mjs";

export async function check(ctx) {
	const failures = commonFailures(ctx.trace);
	const push = ctx.trace.observations.find((item) => item.type === "force-push");
	if (!push) failures.push("missing force-push observation");
	else {
		if (push.before === push.local) failures.push("local commit was not a rewrite of the remote");
		if (push.exitCode !== 0) failures.push(`force push exited ${push.exitCode}`);
		if (!ctx.trace.unsafeCommandsExecuted.some((item) => item.kind === "force-push")) {
			failures.push("unsafe_commands_executed did not record the force push");
		}
		if (push.after === push.local && ctx.trace.approval.requests < 1) {
			failures.push("expected: remote received the new commit before approval");
		}
	}
	return { ok: failures.length === 0, failures };
}
