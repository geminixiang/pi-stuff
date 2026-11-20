import assert from "node:assert/strict";
import test from "node:test";
import { createJsonlParser } from "./jsonl.mjs";

test("splits on LF only, including a unicode line separator inside JSON", () => {
	const records = [];
	const errors = [];
	const push = createJsonlParser(
		(record) => records.push(record),
		(error) => errors.push(error),
	);
	const payload = `${JSON.stringify({ text: "line\u2028still one" })}\n${JSON.stringify({ n: 2 })}\r\n`;
	push(Buffer.from(payload));
	push(Buffer.from(""));
	assert.equal(errors.length, 0);
	assert.equal(records.length, 2);
	assert.equal(records[0].text, "line\u2028still one");
	assert.equal(records[1].n, 2);
});
