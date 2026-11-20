const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deterministic tasks that spawn processes use the real clock.
 * `fake` installs node:test mock timers so a later grid check can advance
 * setTimeout/Date without waiting. Fake mode is not process-safe: child
 * processes keep real time, and the mocked globals replace the runner's timers.
 */
export async function createClock(mode = "real") {
	if (mode !== "fake") {
		return {
			mode: "real",
			now: () => Date.now(),
			sleep: realSleep,
			async tick(ms) {
				await realSleep(ms);
			},
			dispose() {},
		};
	}
	const { mock } = await import("node:test");
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
	return {
		mode: "fake",
		now: () => Date.now(),
		async sleep(ms) {
			mock.timers.tick(ms);
		},
		async tick(ms) {
			mock.timers.tick(ms);
			await Promise.resolve();
		},
		dispose() {
			mock.timers.reset();
		},
	};
}
