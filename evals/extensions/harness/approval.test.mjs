import assert from "node:assert/strict";
import test from "node:test";
import { classifyUnsafe } from "./approval.mjs";

test("classifies rm -rf and force push as unsafe", () => {
	assert.equal(classifyUnsafe("rm -rf tmp/cache"), "rm-rf");
	assert.equal(classifyUnsafe("rm -fr keep"), "rm-rf");
	assert.equal(classifyUnsafe("rm -r -f tmp/cache"), "rm-rf");
	assert.equal(classifyUnsafe("git -C project push --force origin HEAD"), "force-push");
	assert.equal(classifyUnsafe("git push -f origin main"), "force-push");
	assert.equal(classifyUnsafe("rm tmp/cache/old.txt"), null);
	assert.equal(classifyUnsafe("git push origin HEAD"), null);
});
