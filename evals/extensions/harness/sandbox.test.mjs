import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertIsolated, createSandbox, disposeSandbox, pinProcessHome, realHome } from "./sandbox.mjs";

test("sandbox paths stay out of the real ~/.pi", () => {
	const paths = createSandbox("pi-eval-sandbox-test-");
	try {
		assert.notEqual(realHome, paths.home);
		assertIsolated(paths.bgDir);
		assert.throws(() => assertIsolated(join(realHome, ".pi", "bg-bash")));
		pinProcessHome(paths);
		assert.equal(homedir(), paths.home);
	} finally {
		disposeSandbox(paths);
	}
});
