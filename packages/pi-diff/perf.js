const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");

const lib = { require, module: { exports: {} }, process, setTimeout, clearTimeout, setInterval, clearInterval };
vm.runInNewContext(readFileSync("extensions/pi-diff.js", "utf8"), lib);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function time(label, fn) {
	const start = performance.now();
	const value = await fn();
	return { label, ms: Math.round(performance.now() - start), value };
}

async function waitUntil(fn, timeoutMs = 5000) {
	const start = performance.now();
	while (performance.now() - start < timeoutMs) {
		if (fn()) return;
		await wait(25);
	}
	throw new Error("Timed out waiting for performance condition");
}

(async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-diff-perf-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["config", "user.email", "perf@example.test"], { cwd });
		execFileSync("git", ["config", "user.name", "Perf Test"], { cwd });
		writeFileSync(join(cwd, ".gitignore"), "ignored/\n");

		for (let i = 0; i < 200; i++) writeFileSync(join(cwd, `tracked-${i}.txt`), "base\n");
		mkdirSync(join(cwd, "ignored"));
		for (let i = 0; i < 2000; i++) writeFileSync(join(cwd, "ignored", `cache-${i}.txt`), "skip\n");
		execFileSync("git", ["add", ".gitignore", "*.txt"], { cwd });
		execFileSync("git", ["commit", "-qm", "seed"], { cwd });

		const initialKey = await time("initial changeKey", () => lib.changeKey(cwd));
		const ignored = await time("ignoredRoots", () => lib.ignoredRoots(cwd));
		assert.deepEqual(Array.from(ignored.value), [join(cwd, "ignored")]);

		let checks = 0;
		let reloads = 0;
		const state = lib.createMonitorState({
			changeKey: async (repo) => { checks++; return lib.changeKey(repo); },
			notify: () => { reloads++; },
			debounceMs: 100,
			safetyPollMs: 60000,
		});

		const startup = await time("monitor startup", () => lib.startChangeMonitor(cwd, state));
		await wait(500);
		assert.equal(reloads, 0, "startup must not reload");

		const afterStartupChecks = checks;
		const trackedBurst = await time("100 tracked writes burst", async () => {
			for (let i = 0; i < 100; i++) appendFileSync(join(cwd, "tracked-0.txt"), `edit ${i}\n`);
			await waitUntil(() => reloads === 1);
			await wait(300);
		});
		const trackedBurstChecks = checks - afterStartupChecks;
		assert.ok(trackedBurstChecks <= 3, `tracked burst should be coalesced, got ${trackedBurstChecks} checks`);

		const beforeIgnored = checks;
		const ignoredBurst = await time("100 ignored writes burst", async () => {
			for (let i = 0; i < 100; i++) appendFileSync(join(cwd, "ignored", "cache-0.txt"), `ignored ${i}\n`);
			await wait(500);
		});
		assert.equal(checks - beforeIgnored, 0, "ignored writes should not trigger changeKey");

		await lib.stopChangeMonitor(state);

		console.table([
			{ metric: initialKey.label, value: `${initialKey.ms} ms` },
			{ metric: ignored.label, value: `${ignored.ms} ms` },
			{ metric: startup.label, value: `${startup.ms} ms` },
			{ metric: trackedBurst.label, value: `${trackedBurst.ms} ms` },
			{ metric: "changeKey calls for tracked burst", value: trackedBurstChecks },
			{ metric: ignoredBurst.label, value: `${ignoredBurst.ms} ms` },
			{ metric: "changeKey calls for ignored burst", value: checks - beforeIgnored },
			{ metric: "reload notifications", value: reloads },
		]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
})();
