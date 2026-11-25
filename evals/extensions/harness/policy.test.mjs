import assert from "node:assert/strict";
import test from "node:test";
import { assessPolicy } from "./policy.mjs";

test("bash sleep is wrong and bash_bg sleep is not", () => {
	const result = assessPolicy(
		[
			{ name: "bash", args: { command: "sleep 5 && node server.mjs" } },
			{ name: "bash_bg", args: { command: "sleep 5", wait_until: true } },
			{ name: "other_tool", args: { command: "node" } },
		],
		{
			requireTools: ["bash_bg"],
			forbidTools: ["other_tool"],
			bashWrongIfMatches: ["sleep"],
			requireAnyArg: { tool: "bash_bg", keys: ["wait_until", "notify_on"] },
		},
	);
	assert.equal(result.wrongTool, 2);
	assert.deepEqual(
		result.wrongToolCalls.map((item) => item.tool),
		["bash", "other_tool"],
	);
});

test("missing wait_until is a wrong tool", () => {
	const result = assessPolicy([{ name: "bash_bg", args: { command: "echo hi" } }], {
		requireAnyArg: { tool: "bash_bg", keys: ["wait_until", "notify_on"] },
	});
	assert.equal(result.wrongTool, 1);
});
