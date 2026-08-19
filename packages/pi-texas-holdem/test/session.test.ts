import assert from "node:assert/strict";
import test from "node:test";
import { createBotsSession } from "../src/session/bots.ts";

const options = {
	myId: "me",
	displayName: "player",
	seatCount: 2,
	smallBlind: 5,
	bigBlind: 10,
	startingStack: 100,
};

test("bots session exposes the shared boundary and emits state/chat changes", () => {
	const timers: (() => void)[] = [];
	const session = createBotsSession(options, {
		random: () => 0.5,
		now: () => 123,
		setTimer: (callback) => {
			timers.push(callback);
			return 1 as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: () => {},
	});
	let emissions = 0;
	const unsubscribe = session.subscribe(() => emissions++);

	assert.equal(session.info.mySeatIndex, 0);
	assert.equal(session.canStartHand(), true);
	session.sendChat(" hello\nworld ");
	assert.equal(session.getChatLog().at(-1)?.text, "hello world");
	assert.equal(session.getChatLog().at(-1)?.ts, 123);

	session.startHand();
	assert.equal(session.getState().handNumber, 1);
	assert.ok(emissions >= 2);
	assert.ok(timers.length <= 1, "at most one bot turn is scheduled");

	unsubscribe();
	session.close();
});

test("bots session uses the injected random source to shuffle deterministically", () => {
	const first = createBotsSession(options, { random: () => 0.25, setTimer: setTimeout });
	const second = createBotsSession(options, { random: () => 0.25, setTimer: setTimeout });
	try {
		first.startHand();
		second.startHand();
		assert.deepEqual(first.getState(), second.getState());
	} finally {
		first.close();
		second.close();
	}
});
