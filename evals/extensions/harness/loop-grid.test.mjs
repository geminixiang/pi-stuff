import assert from "node:assert/strict";
import test from "node:test";
import { scoreLoopGrid } from "./loop-grid.mjs";

test("an exact one-minute grid has no drift, misses, or duplicates", () => {
	const score = scoreLoopGrid([1, 60_001, 120_001], 60_000);
	assert.equal(score.driftMs, 0);
	assert.equal(score.missed, 0);
	assert.equal(score.duplicates, 0);
	assert.equal(score.aligned, true);
});

test("a catch-up burst marks duplicates and a skipped slot is missed", () => {
	const burst = scoreLoopGrid([0, 0], 60_000);
	assert.equal(burst.duplicates, 1);
	const gap = scoreLoopGrid([0, 120_000], 60_000);
	assert.equal(gap.missed, 1);
	assert.equal(gap.driftMs, 0);
});
