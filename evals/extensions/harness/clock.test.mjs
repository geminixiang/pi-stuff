import assert from "node:assert/strict";
import test from "node:test";
import { createClock } from "./clock.mjs";

test("fake clock fires a long timer without waiting", async () => {
	const clock = await createClock("fake");
	try {
		let fired = false;
		setTimeout(() => {
			fired = true;
		}, 60_000);
		assert.equal(fired, false);
		await clock.tick(60_000);
		assert.equal(fired, true);
		assert.equal(clock.now(), 60_000);
	} finally {
		clock.dispose();
	}
});
