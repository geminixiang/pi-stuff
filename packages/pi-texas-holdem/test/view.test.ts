import assert from "node:assert/strict";
import test from "node:test";
import { createTable, seatPlayer, startHand } from "../src/engine/table.ts";
import { redactStateFor } from "../src/engine/view.ts";

test("redactStateFor hides other players' hole cards but keeps your own", () => {
	let state = createTable({ seatCount: 3, smallBlind: 5, bigBlind: 10 });
	state = seatPlayer(state, 0, { id: "a", displayName: "a", stack: 100 });
	state = seatPlayer(state, 1, { id: "b", displayName: "b", stack: 100 });
	state = startHand(state);

	const viewA = redactStateFor(state, "a");
	const seatA = viewA.seats[0]!;
	const seatB = viewA.seats[1]!;
	assert.equal(seatA.holeCards.every((c) => c !== null), true, "you can see your own hole cards");
	assert.equal(seatB.holeCards.every((c) => c === null), true, "opponent hole cards are hidden");
});

test("redactStateFor reveals non-folded hands to everyone at showdown", () => {
	let state = createTable({ seatCount: 2, smallBlind: 5, bigBlind: 10 });
	state = seatPlayer(state, 0, { id: "a", displayName: "a", stack: 100 });
	state = seatPlayer(state, 1, { id: "b", displayName: "b", stack: 100 });
	state = startHand(state);
	state = { ...state, street: "showdown" };

	const spectatorView = redactStateFor(state, "someone-else");
	for (const seat of spectatorView.seats) {
		if (!seat) continue;
		assert.equal(seat.holeCards.every((c) => c !== null), true, "showdown reveals non-folded hands");
	}
});

test("redactStateFor keeps a folded seat's cards hidden even at showdown", () => {
	let state = createTable({ seatCount: 2, smallBlind: 5, bigBlind: 10 });
	state = seatPlayer(state, 0, { id: "a", displayName: "a", stack: 100 });
	state = seatPlayer(state, 1, { id: "b", displayName: "b", stack: 100 });
	state = startHand(state);
	const seats = state.seats.map((s) => (s ? { ...s } : null));
	seats[0]!.status = "folded";
	state = { ...state, seats, street: "showdown" };

	const view = redactStateFor(state, "b");
	assert.equal(view.seats[0]!.holeCards.every((c) => c === null), true, "folded hands stay face down");
});
