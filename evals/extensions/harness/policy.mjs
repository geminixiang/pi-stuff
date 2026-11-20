/**
 * Classify tool calls for the bash / bash_bg / supervisor interplay metric.
 * A bash_bg command may itself contain sleep (the job). Only the built-in
 * `bash` tool is matched against bashWrongIfMatches.
 */
export function assessPolicy(toolCalls, policy = {}) {
	const wrong = [];
	const names = new Set(toolCalls.map((call) => call.name));
	for (const name of policy.requireTools ?? []) {
		if (!names.has(name)) wrong.push({ tool: name, reason: `required tool ${name} was not used` });
	}
	for (const call of toolCalls) {
		if ((policy.forbidTools ?? []).includes(call.name)) {
			wrong.push({ tool: call.name, reason: `${call.name} is forbidden for this task` });
		}
		if (call.name !== "bash" || !policy.bashWrongIfMatches) continue;
		const command = String(call.args?.command ?? "");
		for (const pattern of policy.bashWrongIfMatches) {
			if (new RegExp(pattern, "i").test(command)) {
				wrong.push({ tool: "bash", reason: `bash command matches /${pattern}/` });
				break;
			}
		}
	}
	if (policy.requireAnyArg) {
		const { tool, keys } = policy.requireAnyArg;
		const calls = toolCalls.filter((call) => call.name === tool);
		const ok = calls.some((call) => keys.some((key) => call.args?.[key]));
		if (!ok) wrong.push({ tool, reason: `${tool} is missing one of: ${keys.join(", ")}` });
	}
	return { wrongTool: wrong.length, wrongToolCalls: wrong };
}
